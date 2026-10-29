import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME_TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t"
};

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(body);
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
}

export function createApi(config, sessions) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        });
        return response.end();
      }

      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, "ok");

      const hlsMatch = url.pathname.match(/^\/stream\/(\d+)\/(index\.m3u8|segment_\d+\.ts)$/);
      if (request.method === "GET" && hlsMatch) {
        const slot = Number(hlsMatch[1]);
        if (!Number.isInteger(slot) || slot < 0 || slot >= config.slotCount) return send(response, 404, "not found");
        const filename = path.join(config.dataRoot, "hls", String(slot), hlsMatch[2]);
        try {
          const stat = await fs.promises.stat(filename);
          response.writeHead(200, {
            "Content-Type": MIME_TYPES[path.extname(filename)],
            "Content-Length": stat.size,
            "Cache-Control": filename.endsWith(".m3u8") ? "no-store" : "public, max-age=10",
            "Access-Control-Allow-Origin": "*"
          });
          const stream = fs.createReadStream(filename);
          stream.on("error", () => response.destroy());
          return stream.pipe(response);
        } catch {
          return send(response, 404, "stream not ready");
        }
      }

      let createProfile;
      const fixedCreate = url.pathname.match(/^\/api\/session\/create\/(user1|user2|guest)$/);
      if (request.method === "GET" && fixedCreate) createProfile = fixedCreate[1];
      if (request.method === "POST" && url.pathname === "/api/session/create") {
        createProfile = (await readJson(request)).profile;
      }
      if (createProfile) {
        const session = await sessions.create(createProfile);
        return send(response, 201, String(session.slot));
      }

      const apiMatch = url.pathname.match(/^\/api\/session\/(\d+)\/(next|prev|like|favorite|heartbeat|close)$/);
      if (apiMatch && (request.method === "GET" || request.method === "POST")) {
        const slot = Number(apiMatch[1]);
        const action = apiMatch[2];
        if (action === "heartbeat") sessions.heartbeat(slot);
        else if (action === "close") await sessions.close(slot);
        else await sessions.action(slot, action);
        return send(response, 200, "ok");
      }

      return send(response, 404, "not found");
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("already active") ? 409
        : message.includes("occupied") ? 503
        : message.includes("invalid") || message.includes("profile must") ? 400
        : message.includes("not active") ? 404
        : 500;
      return send(response, status, message);
    }
  });
}
