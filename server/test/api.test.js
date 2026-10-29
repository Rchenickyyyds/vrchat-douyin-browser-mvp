import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApi } from "../src/api.js";
import { digest } from "../src/access.js";
import { ProfileManager } from "../src/profile-manager.js";
import { SessionManager } from "../src/session-manager.js";
import { SlotManager } from "../src/slot-manager.js";

const aliceToken = "A".repeat(43), bobToken = "B".repeat(43);

async function fixture(t, slotCount = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-api-"));
  const config = {
    slotCount, dataRoot: root, publicOrigin: "http://localhost:8080",
    sessionTtlSeconds: 300, viewTtlSeconds: 60, heartbeatTimeoutSeconds: 90,
    selectors: { nextKeys: ["ArrowDown"], prevKeys: ["ArrowUp"], like: ["like"], favorite: ["favorite"] },
    users: [
      { id: "alice", tokenHash: digest(aliceToken), profiles: ["guest", "user1"], maxSessions: slotCount },
      { id: "bob", tokenHash: digest(bobToken), profiles: ["guest"], maxSessions: slotCount }
    ]
  };
  const calls = { launches: 0, closes: 0, actions: [] };
  const profiles = new ProfileManager(root);
  await profiles.initialize();
  const browser = { async launch() {
    calls.launches++;
    return { context: { async close() { calls.closes++; } }, page: {
      async bringToFront() {},
      keyboard: { async press(key) { calls.actions.push(key); } },
      locator(selector) { return { async count() { return 1; }, nth() { return {
        async isVisible() { return true; }, async click() { calls.actions.push(selector); }
      }; } }; }
    } };
  } };
  const streams = {
    async prepare(slot, id) {
      const hlsDirectory = path.join(root, "hls", id);
      await fs.mkdir(hlsDirectory, { recursive: true });
      await fs.writeFile(path.join(hlsDirectory, "index.m3u8"), "#EXTM3U\n#EXTINF:1,\nsegment_0.ts\n");
      await fs.writeFile(path.join(hlsDirectory, "segment_0.ts"), "test-segment");
      return { slot, hlsDirectory, display: ":90", pulseSink: "test" };
    },
    async start() { return "test-encoder"; },
    async stop(resources) { await fs.rm(resources.hlsDirectory, { recursive: true, force: true }); }
  };
  const sessions = new SessionManager(config, new SlotManager(slotCount), profiles, browser, streams);
  const server = createApi(config, sessions);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicOrigin = base;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sessions.closeAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function request(route, { token = aliceToken, method = "GET", origin, json, body, contentType } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    if (json !== undefined) { body = JSON.stringify(json); headers["Content-Type"] = "application/json"; }
    if (contentType) headers["Content-Type"] = contentType;
    const response = await fetch(`${base}${route}`, { method, headers, body });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
  }
  async function create(token = aliceToken, profile = "guest") {
    const response = await request("/api/sessions", { token, method: "POST", json: { profile } });
    assert.equal(response.status, 201);
    return response.json();
  }
  return { root, config, sessions, calls, request, create, base };
}

test("health reports a quarantined or shutting-down worker as unavailable", async (t) => {
  const f = await fixture(t);
  try {
    f.sessions.unhealthy = true;
    const failed = await f.request("/health", { token: null });
    assert.equal(failed.status, 503);
    assert.equal(failed.text, "unavailable");
    f.sessions.unhealthy = false;
    f.sessions.shuttingDown = true;
    assert.equal((await f.request("/health", { token: null })).status, 503);
  } finally { f.sessions.unhealthy = false; f.sessions.shuttingDown = false; }
  assert.equal((await f.request("/health", { token: null })).status, 200);
});

test("API requires authentication and removes anonymous fixed GET control routes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/health", { token: null })).status, 200);
  for (const token of [null, "wrong", "Z".repeat(43)]) {
    assert.equal((await f.request("/api/sessions", { token })).status, 401);
  }
  assert.equal((await f.request("/api/sessions", { token: null, method: "POST", json: {} })).status, 401);
  for (const route of ["/api/session/create/guest", "/api/session/create/user1", "/api/session/0/next", "/api/session/0/heartbeat", "/api/session/0/close"]) {
    assert.equal((await f.request(route)).status, 404);
  }
  assert.equal((await f.request("/api/sessions", { method: "PUT" })).status, 405);
  assert.equal((await f.request("/api/sessions?token=not-accepted")).status, 400);
  assert.equal(f.calls.launches, 0);
});

test("foreign Origin is rejected and responses do not grant wildcard CORS", async (t) => {
  const f = await fixture(t);
  const refused = await f.request("/api/sessions", { method: "POST", origin: "https://elsewhere.example", json: {} });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
  const allowed = await f.request("/api/sessions", { origin: f.base });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("referrer-policy"), "no-referrer");
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal(allowed.headers.get("x-content-type-options"), "nosniff");
  assert.equal(f.calls.launches, 0);
});

test("anonymous failures behind one proxy cannot exhaust an authenticated owner's rate bucket", async (t) => {
  const f = await fixture(t);
  const statuses = [];
  for (let index = 0; index < 185; index++) {
    statuses.push((await f.request("/api/sessions", { token: null })).status);
  }
  assert(statuses.slice(0, 180).every((status) => status === 401));
  assert(statuses.slice(180).every((status) => status === 429));
  assert.equal((await f.request("/api/sessions")).status, 200);
  const created = await f.create();
  assert.equal((await f.request(`/api/sessions/${created.id}/heartbeat`, { token: created.controlToken, method: "POST" })).status, 200);
  assert.equal((await f.request(`/api/sessions/${created.id}/next`, { method: "POST" })).status, 200);
});

test("creation rejects non-JSON, malformed JSON and unexpected object fields", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/sessions", { method: "POST", body: "{}", contentType: "text/plain" })).status, 415);
  assert.equal((await f.request("/api/sessions", { method: "POST", body: "{", contentType: "application/json" })).status, 400);
  assert.equal((await f.request("/api/sessions", { method: "POST", json: { profile: "guest", owner: "bob" } })).status, 400);
  assert.equal(f.calls.launches, 0);
});

test("creation body size is bounded before browser allocation", async (t) => {
  const f = await fixture(t);
  const result = await f.request("/api/sessions", { method: "POST", body: JSON.stringify({ profile: "x".repeat(8200) }), contentType: "application/json" });
  assert.equal(result.status, 413);
  assert.equal(f.calls.launches, 0);
});

test("creation rejects JSON values that are not profile objects", async (t) => {
  const f = await fixture(t);
  for (const json of [null, [], "guest"]) {
    assert.equal((await f.request("/api/sessions", { method: "POST", json })).status, 400);
  }
  assert.equal(f.calls.launches, 0);
});

test("profile permissions, owner-only listing and session-bound control are enforced", async (t) => {
  const f = await fixture(t, 4);
  assert.equal((await f.request("/api/sessions", { token: bobToken, method: "POST", json: { profile: "user1" } })).status, 403);
  const alice1 = await f.create();
  const alice2 = await f.create(aliceToken, "user1");
  const bob = await f.create(bobToken);
  assert.deepEqual((await f.request("/api/sessions")).json().map((s) => s.id).sort(), [alice1.id, alice2.id].sort());
  const bobList = await f.request("/api/sessions", { token: bobToken });
  assert.deepEqual(bobList.json().map((s) => s.id), [bob.id]);
  assert.doesNotMatch(bobList.text, /controlToken|viewUrl|tokenHash|ownerId|profilePath/);
  const action = (id, token) => f.request(`/api/sessions/${id}/next`, { token, method: "POST" });
  for (const actionName of ["next", "prev", "like", "favorite", "heartbeat", "close", "share"]) {
    assert.equal((await f.request(`/api/sessions/${alice1.id}/${actionName}`, { token: bobToken, method: "POST" })).status, 404);
  }
  assert.equal((await action(bob.id, alice1.controlToken)).status, 404);
  assert.equal((await action(alice2.id, alice1.controlToken)).status, 404);
  assert.equal((await action(alice1.id, alice1.controlToken)).status, 200);
  assert.equal((await action(alice2.id, aliceToken)).status, 200);
  assert.equal((await f.request(`/api/sessions/${alice1.id}/next`)).status, 405);
  assert.deepEqual(f.calls.actions, ["ArrowDown", "ArrowDown"]);
});

test("view capability reads playlist and segments but cannot control or list sessions", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const viewPath = new URL(session.viewUrl).pathname;
  const viewToken = viewPath.split("/")[3];
  const playlist = await f.request(viewPath, { token: null });
  assert.equal(playlist.status, 200);
  assert.equal(playlist.headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.match(playlist.text, /\nsegment_0\.ts\n/);
  assert.equal(playlist.headers.get("cache-control"), "no-store");
  assert.equal((await f.request(viewPath.replace("index.m3u8", "segment_0.ts"), { token: null })).text, "test-segment");
  assert.equal((await f.request(viewPath.replace(viewToken, session.controlToken), { token: null })).status, 404);
  assert.equal((await f.request(`/stream/${session.slot}/index.m3u8`, { token: null })).status, 404);
  assert.equal((await f.request(`/api/sessions/${session.id}/close`, { method: "POST", token: viewToken })).status, 404);
  assert.equal((await f.request("/api/sessions", { token: session.controlToken })).status, 401);
});

test("owner listing excludes expired sessions before the next cleanup sweep", async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  const second = await f.create();
  f.sessions.byId.get(first.id).expiresAt = Date.now() - 1;
  assert.deepEqual((await f.request("/api/sessions")).json().map((s) => s.id), [second.id]);
  f.sessions.byId.get(second.id).lastHeartbeat = Date.now() - 91000;
  assert.deepEqual((await f.request("/api/sessions")).json(), []);
  assert.equal(f.sessions.byId.size, 2);
});

test("share rotation, expiry, closing and slot reuse reject old viewing tokens", async (t) => {
  const f = await fixture(t, 1);
  const first = await f.create();
  const oldPath = new URL(first.viewUrl).pathname;
  const share = await f.request(`/api/sessions/${first.id}/share`, { method: "POST", token: first.controlToken });
  assert.equal(share.status, 200);
  const newPath = new URL(share.json().viewUrl).pathname;
  assert.notEqual(oldPath, newPath);
  assert.equal((await f.request(oldPath, { token: null })).status, 404);
  assert.equal((await f.request(newPath, { token: null })).status, 200);
  const state = f.sessions.byId.get(first.id);
  state.viewExpiresAt = Date.now() - 1;
  assert.equal((await f.request(newPath, { token: null })).status, 404);
  assert.equal((await f.request(`/api/sessions/${first.id}/heartbeat`, { method: "POST", token: first.controlToken })).status, 200);
  const renewed = await f.request(`/api/sessions/${first.id}/share`, { method: "POST" });
  const renewedPath = new URL(renewed.json().viewUrl).pathname;
  assert.equal((await f.request(renewedPath, { token: null })).status, 200);
  assert.equal((await f.request(`/api/sessions/${first.id}/close`, { method: "POST" })).status, 200);
  assert.equal((await f.request(renewedPath, { token: null })).status, 404);
  const second = await f.create();
  assert.equal(second.slot, first.slot);
  assert.notEqual(second.id, first.id);
  assert.equal((await f.request(oldPath, { token: null })).status, 404);
  assert.equal((await f.request(renewedPath, { token: null })).status, 404);
  const secondPath = new URL(second.viewUrl).pathname;
  const newWithOldToken = secondPath.replace(secondPath.split("/")[3], renewedPath.split("/")[3]);
  assert.equal((await f.request(newWithOldToken, { token: null })).status, 404);
  assert.equal((await f.request(`/api/sessions/${second.id}/next`, { method: "POST", token: first.controlToken })).status, 404);
});

test("concurrent HTTP close requests both wait while closing blocks control and viewing", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const session = f.sessions.byId.get(created.id);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const closing = new Promise((resolve) => { entered = resolve; });
  session.browser.context.close = async () => { f.calls.closes++; entered(); await gate; };
  const route = `/api/sessions/${created.id}/close`;
  const first = f.request(route, { method: "POST" });
  await closing;
  let firstComplete = false, secondComplete = false;
  first.then(() => { firstComplete = true; });
  const second = f.request(route, { method: "POST" });
  second.then(() => { secondComplete = true; });
  try {
    assert.equal((await f.request(new URL(created.viewUrl).pathname, { token: null })).status, 404);
    assert.equal((await f.request(`/api/sessions/${created.id}/next`, { method: "POST" })).status, 404);
    assert.deepEqual((await f.request("/api/sessions")).json(), []);
    assert.equal(firstComplete, false);
    assert.equal(secondComplete, false);
  } finally { release(); }
  assert.deepEqual((await Promise.all([first, second])).map((r) => r.status), [200, 200]);
  assert.equal(f.calls.closes, 1);
});

test("HLS refuses symlink files rather than exposing content outside the session", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const directory = f.sessions.byId.get(created.id).resources.hlsDirectory;
  const outside = path.join(f.root, "outside-private-file");
  await fs.writeFile(outside, "must-not-be-served");
  const viewPath = new URL(created.viewUrl).pathname;
  for (const name of ["index.m3u8", "segment_0.ts"]) {
    await fs.rm(path.join(directory, name));
    await fs.symlink(outside, path.join(directory, name));
    const response = await f.request(viewPath.replace("index.m3u8", name), { token: null });
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.text, /must-not-be-served/);
  }
});
