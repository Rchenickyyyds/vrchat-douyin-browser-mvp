import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bearer, principalFor, RateLimiter } from "./access.js";
import { HttpError } from "./errors.js";

const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
const staticFiles = { "/": ["index.html", "text/html"], "/control.js": ["control.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
const headers = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
};
function send(response, status, body, type = "text/plain; charset=utf-8") {
  response.writeHead(status, { ...headers, "Content-Type": type }); response.end(body);
}
function json(response, status, body) { send(response, status, JSON.stringify(body), "application/json"); }

async function readJson(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] || "")) throw new HttpError(415, "application/json required");
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid JSON"); }
}

function metadata(session) {
  return { id: session.id, slot: session.slot, profile: session.profile.profileType, expiresAt: session.expiresAt, viewExpiresAt: session.viewExpiresAt };
}
function shareResult(config, session, viewToken) {
  return { ...metadata(session), viewUrl: `${config.publicOrigin || ""}/stream/${session.id}/${viewToken}/index.m3u8` };
}

export function createApi(config, sessions) {
  const requests = new RateLimiter(180, 60000);
  const control = new RateLimiter(60, 60000);
  const creates = new RateLimiter(3, 60000);
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 10000, keepAliveTimeout: 5000 }, async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.headers.origin && request.headers.origin !== config.publicOrigin) throw new HttpError(403, "origin is not permitted");
      if (request.method === "GET" && url.pathname === "/health") return send(response, sessions.unhealthy || sessions.shuttingDown ? 503 : 200, sessions.unhealthy || sessions.shuttingDown ? "unavailable" : "ok");
      if (request.method === "GET" && staticFiles[url.pathname]) {
        const [name, type] = staticFiles[url.pathname];
        return send(response, 200, await fs.promises.readFile(path.join(webRoot, name)), type);
      }
      const hls = url.pathname.match(/^\/stream\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{43})\/(index\.m3u8|segment_\d+\.ts)$/);
      if (hls && request.method === "GET") {
        const session = sessions.viewer(hls[1], hls[2]);
        const filename = path.join(session.resources.hlsDirectory, hls[3]);
        let handle;
        try {
          handle = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error("not a file");
          // Recheck revocation after asynchronous file open, before sending any bytes.
          sessions.viewer(hls[1], hls[2]);
          response.writeHead(200, { ...headers, "Content-Type": hls[3].endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t", "Content-Length": stat.size });
          const stream = handle.createReadStream();
          stream.on("error", () => response.destroy());
          response.on("close", () => stream.destroy());
          stream.pipe(response);
          return;
        } catch (error) {
          await handle?.close().catch(() => {});
          if (error instanceof HttpError) throw error;
          throw new HttpError(404, "stream is not ready");
        }
      }
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not found");
      if (url.search) throw new HttpError(400, "API query parameters are not accepted");
      let token;
      try { token = bearer(request); }
      catch (error) { requests.take(request.socket.remoteAddress); throw error; }
      const principal = principalFor(token, config.users);
      if (url.pathname === "/api/sessions") {
        if (!principal) { requests.take(request.socket.remoteAddress); throw new HttpError(401, "invalid operator token"); }
        control.take(principal.id);
        if (request.method === "GET") return json(response, 200, [...sessions.byId.values()].filter((s) => {
          if (s.ownerId !== principal.id) return false;
          try { sessions.get(s.id); return true; } catch { return false; }
        }).map(metadata));
        if (request.method !== "POST") throw new HttpError(405, "method not allowed");
        creates.take(principal.id);
        const body = await readJson(request);
        if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some((key) => key !== "profile")) throw new HttpError(400, "expected a profile object");
        const { session, controlToken, viewToken } = await sessions.create(body.profile || "guest", principal);
        return json(response, 201, { ...shareResult(config, session, viewToken), controlToken });
      }
      const action = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/(next|prev|like|favorite|heartbeat|close|share)$/);
      if (!action) { requests.take(request.socket.remoteAddress); throw new HttpError(404, "not found"); }
      if (request.method !== "POST") throw new HttpError(405, "method not allowed");
      try { sessions.authorize(action[1], token, principal, action[2] === "close"); }
      catch (error) { requests.take(request.socket.remoteAddress); throw error; }
      control.take(principal?.id || action[1]);
      if (action[2] === "close") await sessions.close(action[1]);
      else if (action[2] === "heartbeat") sessions.heartbeat(action[1]);
      else if (action[2] === "share") {
        const { session, viewToken } = sessions.share(action[1]);
        return json(response, 200, shareResult(config, session, viewToken));
      } else await sessions.action(action[1], action[2]);
      return json(response, 200, { ok: true });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(`request failed (${error?.name || "Error"})`);
      if (!response.headersSent) json(response, status, { error: status === 500 ? "operation failed" : error.message });
      else response.destroy();
    }
  });
  server.maxConnections = 128;
  return server;
}
