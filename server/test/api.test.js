import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/api.js";

test("fixed Udon GET URLs map to the session API", async () => {
  const calls = [];
  const sessions = {
    async create(profile) { calls.push(["create", profile]); return { slot: 7 }; },
    heartbeat(slot) { calls.push(["heartbeat", slot]); },
    async action(slot, action) { calls.push([action, slot]); },
    async close(slot) { calls.push(["close", slot]); }
  };
  const server = createApi({ slotCount: 16, dataRoot: "/not-used" }, sessions);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const create = await fetch(`${base}/api/session/create/user1`);
    assert.equal(create.status, 201);
    assert.equal(await create.text(), "7");
    assert.equal((await fetch(`${base}/api/session/7/next`)).status, 200);
    assert.equal((await fetch(`${base}/api/session/7/heartbeat`)).status, 200);
    assert.equal((await fetch(`${base}/api/session/7/close`, { method: "POST" })).status, 200);
    assert.deepEqual(calls, [
      ["create", "user1"],
      ["next", 7],
      ["heartbeat", 7],
      ["close", 7]
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
