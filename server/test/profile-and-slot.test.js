import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProfileManager } from "../src/profile-manager.js";
import { SlotManager } from "../src/slot-manager.js";

test("guest profiles are deleted and permanent profiles remain", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-profile-test-"));
  try {
    const manager = new ProfileManager(root);
    await manager.initialize();
    const guest = await manager.acquire("guest", 0, "alice");
    const permanent = await manager.acquire("user1", 1, "alice");
    await fs.writeFile(path.join(guest.profilePath, "cookie"), "secret");
    await fs.writeFile(path.join(permanent.profilePath, "cookie"), "keep");
    await manager.release(guest);
    await manager.release(permanent);
    await assert.rejects(fs.access(guest.profilePath));
    assert.equal(await fs.readFile(path.join(permanent.profilePath, "cookie"), "utf8"), "keep");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("persistent profiles are scoped to owner and private on disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-owner-test-"));
  try {
    const manager = new ProfileManager(root);
    await manager.initialize();
    await assert.rejects(manager.acquire("user1", 0), /invalid profile owner/);
    const alice = await manager.acquire("user1", 0, "alice");
    const bob = await manager.acquire("user1", 1, "bob");
    assert.notEqual(alice.profilePath, bob.profilePath);
    await assert.rejects(manager.acquire("user1", 2, "alice"), (error) => error.status === 409 && /already active/.test(error.message));
    assert.equal((await fs.stat(alice.profilePath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.dirname(alice.profilePath))).mode & 0o777, 0o700);
    await manager.release(alice);
    const reopened = await manager.acquire("user1", 0, "alice");
    assert.equal(reopened.profilePath, alice.profilePath);
    await manager.release(reopened);
    await manager.release(bob);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("persistent profile symlinks are refused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-symlink-test-"));
  try {
    const manager = new ProfileManager(root);
    await manager.initialize();
    const profile = await manager.acquire("user1", 0, "alice");
    await manager.release(profile);
    await fs.rm(profile.profilePath, { recursive: true });
    await fs.symlink(os.tmpdir(), profile.profilePath);
    await assert.rejects(manager.acquire("user1", 0, "alice"), /unsafe profile directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("slots are unique and reusable", () => {
  const slots = new SlotManager(2);
  assert.equal(slots.reserve(), 0);
  assert.equal(slots.reserve(), 1);
  assert.throws(() => slots.reserve(), /occupied/);
  slots.release(0);
  assert.equal(slots.reserve(), 0);
});
