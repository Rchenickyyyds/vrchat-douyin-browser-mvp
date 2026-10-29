import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { lockDataRoot } from "../src/data-lock.js";

const execFileAsync = promisify(execFile);

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-data-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("a second process cannot use the same data root until its worker releases the lease", async (t) => {
  const root = await temporaryRoot(t);
  const dataRoot = path.join(root, "data");
  const unlock = await lockDataRoot(dataRoot);
  const filename = path.join(dataRoot, ".worker-lock");
  assert.equal((await fs.stat(dataRoot)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  const script = `import { lockDataRoot } from ${JSON.stringify(new URL("../src/data-lock.js", import.meta.url).href)};
const unlock = await lockDataRoot(process.argv[1]); await unlock(); console.log("released");`;
  await assert.rejects(execFileAsync(process.execPath, ["--input-type=module", "--eval", script, dataRoot]), /data root is locked/);
  await unlock();
  await assert.rejects(fs.access(filename), { code: "ENOENT" });
  const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script, dataRoot]);
  assert.equal(result.stdout.trim(), "released");
  await assert.rejects(fs.access(filename), { code: "ENOENT" });
});

test("a symlink data root is rejected without chmod or lock creation in its target", async (t) => {
  const root = await temporaryRoot(t);
  const target = path.join(root, "target"), linked = path.join(root, "linked");
  await fs.mkdir(target, { mode: 0o755 });
  await fs.chmod(target, 0o755);
  await fs.symlink(target, linked);
  await assert.rejects(lockDataRoot(linked), /data root must be a real directory/);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
  await assert.rejects(fs.access(path.join(target, ".worker-lock")), { code: "ENOENT" });
});

test("a lease release cannot remove a replacement worker's lock", async (t) => {
  const root = await temporaryRoot(t);
  const unlock = await lockDataRoot(root);
  const filename = path.join(root, ".worker-lock");
  await fs.writeFile(filename, "replacement-worker\n");
  await unlock();
  assert.equal(await fs.readFile(filename, "utf8"), "replacement-worker\n");
  await assert.rejects(lockDataRoot(root), /data root is locked/);
});

test("a pre-existing lock symlink is not followed or overwritten", async (t) => {
  const root = await temporaryRoot(t);
  const target = path.join(root, "outside");
  const dataRoot = path.join(root, "data");
  await fs.mkdir(dataRoot);
  await fs.writeFile(target, "preserve");
  await fs.symlink(target, path.join(dataRoot, ".worker-lock"));
  await assert.rejects(lockDataRoot(dataRoot), /data root is locked/);
  assert.equal(await fs.readFile(target, "utf8"), "preserve");
});
