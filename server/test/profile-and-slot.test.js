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
    const guest = await manager.acquire("guest", 0);
    const permanent = await manager.acquire("user1", 1);
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

test("slots are unique and reusable", () => {
  const slots = new SlotManager(2);
  assert.equal(slots.reserve(), 0);
  assert.equal(slots.reserve(), 1);
  assert.throws(() => slots.reserve(), /occupied/);
  slots.release(0);
  assert.equal(slots.reserve(), 0);
});
