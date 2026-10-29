import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../src/session-manager.js";
import { SlotManager } from "../src/slot-manager.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ maxSessions = 2, failAt, startGate, closeGate } = {}) {
  const events = [], calls = { acquire: 0, release: 0, prepare: 0, launch: 0, start: 0, close: 0, stop: 0 };
  const startEntered = deferred(), closeEntered = deferred();
  const state = { failAt };
  const config = { slotCount: 2, sessionTtlSeconds: 300, viewTtlSeconds: 60, heartbeatTimeoutSeconds: 90, selectors: {} };
  const owner = { id: "alice", profiles: ["guest", "user1"], maxSessions };
  const profiles = {
    async acquire(profileType, slot, ownerId) {
      calls.acquire++;
      if (state.failAt === "profile") throw new Error("profile failed");
      return { profileType, profilePath: `/test/${ownerId}/${slot}` };
    },
    async release() { events.push("release"); calls.release++; }
  };
  const browser = { async launch() {
    calls.launch++;
    if (state.failAt === "browser") throw new Error("browser failed");
    return { page: {}, context: { async close() {
      calls.close++; events.push("browser close"); closeEntered.resolve();
      if (closeGate) await closeGate.promise;
    } } };
  } };
  const streams = {
    async prepare(slot, id) {
      calls.prepare++;
      if (state.failAt === "prepare") throw new Error("prepare failed");
      return { slot, id, display: ":90", pulseSink: "test", hlsDirectory: `/test/${id}` };
    },
    async start() {
      calls.start++; startEntered.resolve();
      if (startGate) await startGate.promise;
      if (state.failAt === "stream") throw new Error("stream failed");
      return "test-encoder";
    },
    async stop() { events.push("stream stop"); calls.stop++; }
  };
  const slots = new SlotManager(config.slotCount);
  const sessions = new SessionManager(config, slots, profiles, browser, streams);
  return { sessions, slots, owner, calls, events, state, startEntered, closeEntered };
}

test("double close shares completion and closing immediately rejects actions and viewing", async () => {
  const closeGate = deferred();
  const f = fixture({ closeGate });
  const created = await f.sessions.create("guest", f.owner);
  const first = f.sessions.close(created.session.id);
  const second = f.sessions.close(created.session.id);
  assert.equal(first, second);
  let complete = false;
  first.then(() => { complete = true; });
  await f.closeEntered.promise;
  assert.equal(complete, false);
  assert.equal(created.session.closing, true);
  assert.throws(() => f.sessions.action(created.session.id, "next"), (error) => error.status === 404);
  assert.throws(() => f.sessions.viewer(created.session.id, created.viewToken), (error) => error.status === 404);
  assert.equal(f.calls.stop, 1);
  assert.equal(f.calls.release, 0);
  closeGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual([f.calls.close, f.calls.stop, f.calls.release], [1, 1, 1]);
  assert.equal(f.sessions.byId.size, 0);
  assert.deepEqual(f.slots.sessions, [null, null]);
});

test("close drains already accepted actions before releasing browser resources", async () => {
  const f = fixture();
  const { session } = await f.sessions.create("guest", f.owner);
  const actionGate = deferred(), actionEntered = deferred();
  session.controller.next = async () => {
    actionEntered.resolve();
    await actionGate.promise;
    f.events.push("action finished");
  };
  const action = f.sessions.action(session.id, "next");
  await actionEntered.promise;
  const close = f.sessions.close(session.id);
  assert.equal(f.calls.close, 0);
  actionGate.resolve();
  await Promise.all([action, close]);
  assert.deepEqual(f.events, ["action finished", "browser close", "stream stop", "release"]);
});

test("shutdown waits for in-progress creation and prevents publishing its session", async () => {
  const startGate = deferred();
  const f = fixture({ startGate });
  const creation = f.sessions.create("guest", f.owner);
  const rejected = assert.rejects(creation, (error) => error.status === 503);
  await f.startEntered.promise;
  const shutdown = f.sessions.closeAll();
  let complete = false;
  shutdown.then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(f.sessions.byId.size, 0);
  startGate.resolve();
  await Promise.all([rejected, shutdown]);
  assert.deepEqual([f.calls.close, f.calls.stop, f.calls.release], [1, 1, 1]);
  assert.deepEqual(f.slots.sessions, [null, null]);
  assert.equal(f.sessions.pending.size, 0);
  assert.equal(f.sessions.creating.get(f.owner.id), 0);
  await assert.rejects(f.sessions.create("guest", f.owner), (error) => error.status === 503);
});

for (const [stage, cleanup] of [
  ["profile", [0, 0, 0]], ["prepare", [0, 0, 1]],
  ["browser", [0, 1, 1]], ["stream", [1, 1, 1]]
]) {
  test(`creation failure at ${stage} releases previously acquired resources and capacity`, async () => {
    const f = fixture({ maxSessions: 1, failAt: stage });
    await assert.rejects(f.sessions.create("guest", f.owner), new RegExp(`${stage} failed`));
    assert.deepEqual([f.calls.close, f.calls.stop, f.calls.release], cleanup);
    assert.deepEqual(f.slots.sessions, [null, null]);
    assert.equal(f.sessions.byId.size, 0);
    assert.equal(f.sessions.pending.size, 0);
    assert.equal(f.sessions.creating.get(f.owner.id), 0);
    f.state.failAt = undefined;
    const created = await f.sessions.create("guest", f.owner);
    assert.equal(created.session.slot, 0);
    await f.sessions.closeAll();
  });
}

test("per-owner quota counts pending creation as well as active sessions", async () => {
  const startGate = deferred();
  const f = fixture({ maxSessions: 1, startGate });
  const pending = f.sessions.create("guest", f.owner);
  await f.startEntered.promise;
  await assert.rejects(f.sessions.create("guest", f.owner), (error) => error.status === 409);
  assert.equal(f.calls.launch, 1);
  startGate.resolve();
  const created = await pending;
  await assert.rejects(f.sessions.create("guest", f.owner), (error) => error.status === 409);
  await f.sessions.close(created.session.id);
  const reused = await f.sessions.create("guest", f.owner);
  assert.equal(reused.session.slot, 0);
  await f.sessions.closeAll();
});

test("action queue is bounded, serial and releases its budget after failures", async () => {
  const f = fixture();
  const { session } = await f.sessions.create("guest", f.owner);
  const firstGate = deferred(), firstEntered = deferred();
  let running = 0, highestRunning = 0, completed = 0;
  session.controller.next = async () => {
    running++; highestRunning = Math.max(highestRunning, running);
    if (!completed) { firstEntered.resolve(); await firstGate.promise; }
    completed++; running--;
  };
  const accepted = Array.from({ length: 8 }, () => f.sessions.action(session.id, "next"));
  await firstEntered.promise;
  assert.throws(() => f.sessions.action(session.id, "next"), (error) => error.status === 429);
  assert.equal(session.pendingActions, 8);
  firstGate.resolve();
  await Promise.all(accepted);
  assert.equal(highestRunning, 1);
  assert.equal(completed, 8);
  assert.equal(session.pendingActions, 0);
  session.controller.next = async () => { throw new Error("action failed"); };
  await assert.rejects(f.sessions.action(session.id, "next"), /action failed/);
  assert.equal(session.pendingActions, 0);
  session.controller.next = async () => { completed++; };
  await f.sessions.action(session.id, "next");
  assert.equal(completed, 9);
  await f.sessions.closeAll();
});

test("global slot exhaustion does not leak pending owner quota", async () => {
  const f = fixture();
  await f.sessions.create("guest", f.owner);
  await f.sessions.create("guest", f.owner);
  const bob = { id: "bob", profiles: ["guest"], maxSessions: 1 };
  await assert.rejects(f.sessions.create("guest", bob), (error) => error.status === 503);
  assert.equal(f.sessions.creating.get("bob"), 0);
  assert.equal(f.calls.acquire, 2);
  await f.sessions.close([...f.sessions.byId.keys()][0]);
  const created = await f.sessions.create("guest", bob);
  assert.equal(created.session.ownerId, "bob");
  await f.sessions.closeAll();
});

test("absolute and heartbeat expiry revoke control and viewing before sweeping cleanup", async () => {
  const f = fixture();
  const first = await f.sessions.create("guest", f.owner);
  first.session.expiresAt = Date.now() - 1;
  assert.throws(() => f.sessions.authorize(first.session.id, first.controlToken), (error) => error.status === 404);
  assert.throws(() => f.sessions.viewer(first.session.id, first.viewToken), (error) => error.status === 404);
  await f.sessions.sweepExpired();
  assert.equal(f.sessions.byId.size, 0);
  const second = await f.sessions.create("guest", f.owner);
  second.session.lastHeartbeat = Date.now() - 91000;
  assert.throws(() => f.sessions.authorize(second.session.id, second.controlToken), (error) => error.status === 404);
  assert.throws(() => f.sessions.viewer(second.session.id, second.viewToken), (error) => error.status === 404);
  await f.sessions.sweepExpired();
  assert.deepEqual(f.slots.sessions, [null, null]);
});

for (const stage of ["browser", "stream", "profile"]) {
  test(`failed ${stage} cleanup quarantines its session and refuses worker reuse`, async () => {
    const f = fixture();
    const { session } = await f.sessions.create("user1", f.owner);
    if (stage === "browser") session.browser.context.close = async () => { f.calls.close++; throw new Error("browser cleanup failed"); };
    if (stage === "stream") f.sessions.streams.stop = async () => { f.calls.stop++; throw new Error("stream cleanup failed"); };
    if (stage === "profile") f.sessions.profiles.release = async () => { f.calls.release++; throw new Error("profile cleanup failed"); };
    await assert.rejects(f.sessions.close(session.id), /cleanup/);
    assert.equal(f.sessions.unhealthy, true);
    assert.equal(session.closing, true);
    assert.equal(f.sessions.byId.get(session.id), session);
    assert.equal(f.slots.get(session.slot), session);
    assert.throws(() => f.sessions.get(session.id), (error) => error.status === 404);
    await assert.rejects(f.sessions.create("guest", f.owner), (error) => error.status === 503);
    assert.equal(f.calls.acquire, 1);
    assert.equal(f.calls.release, stage === "profile" ? 1 : 0);
    await assert.rejects(f.sessions.closeAll(), /cleanup incomplete/);
    assert.equal(f.slots.get(session.slot), session);
    assert.equal(f.calls.close, 1);
    assert.equal(f.calls.stop, 1);
  });
}

test("failed cleanup during creation retains reservation and profile instead of reusing them", async () => {
  const f = fixture({ failAt: "stream" });
  f.sessions.streams.stop = async () => { f.calls.stop++; throw new Error("cleanup failed"); };
  await assert.rejects(f.sessions.create("user1", f.owner), /stream failed/);
  assert.equal(f.sessions.unhealthy, true);
  assert.deepEqual(f.slots.sessions, [{ reserving: true }, null]);
  assert.equal(f.calls.release, 0);
  assert.equal(f.sessions.byId.size, 0);
  assert.equal(f.sessions.pending.size, 0);
  assert.equal(f.sessions.creating.get(f.owner.id), 0);
  await assert.rejects(f.sessions.create("guest", f.owner), (error) => error.status === 503);
  await assert.rejects(f.sessions.closeAll(), /cleanup incomplete/);
  assert.equal(f.calls.acquire, 1);
  assert.equal(f.calls.release, 0);
});

test("uncertain partial resource preparation also quarantines the worker", async () => {
  const f = fixture();
  f.sessions.streams.prepare = async () => { throw new AggregateError([new Error("resource still running")], "partial cleanup failed"); };
  await assert.rejects(f.sessions.create("user1", f.owner), AggregateError);
  assert.equal(f.sessions.unhealthy, true);
  assert.deepEqual(f.slots.sessions, [{ reserving: true }, null]);
  assert.equal(f.calls.release, 0);
  await assert.rejects(f.sessions.create("guest", f.owner), (error) => error.status === 503);
  await assert.rejects(f.sessions.closeAll(), /cleanup incomplete/);
});

test("in-flight creation cannot publish after another session makes the worker unhealthy", async () => {
  const f = fixture();
  const first = await f.sessions.create("user1", f.owner);
  const startGate = deferred(), startEntered = deferred();
  f.sessions.streams.start = async () => {
    f.calls.start++;
    startEntered.resolve();
    await startGate.promise;
    return "test-encoder";
  };
  const bob = { id: "bob", profiles: ["guest"], maxSessions: 1 };
  const pending = f.sessions.create("guest", bob);
  const rejected = assert.rejects(pending, (error) => error.status === 503);
  await startEntered.promise;
  first.session.browser.context.close = async () => { f.calls.close++; throw new Error("browser cleanup failed"); };
  await assert.rejects(f.sessions.close(first.session.id), /cleanup incomplete/);
  assert.equal(f.sessions.unhealthy, true);
  startGate.resolve();
  await rejected;
  assert.deepEqual([...f.sessions.byId.keys()], [first.session.id]);
  assert.equal(f.slots.get(first.session.slot), first.session);
  assert.equal(f.slots.sessions[1], null);
  assert.equal(f.sessions.pending.size, 0);
  assert.equal(f.sessions.creating.get("bob"), 0);
  assert.deepEqual([f.calls.close, f.calls.stop, f.calls.release], [2, 2, 1]);
  await assert.rejects(f.sessions.closeAll(), /cleanup incomplete/);
});
