import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { bearer, digest, loadAccess, matches, newToken, principalFor, RateLimiter } from "../src/access.js";

const entry = (changes = {}) => ({ id: "alice", token: "A".repeat(43), profiles: ["guest"], maxSessions: 1, ...changes });
async function accessFile(t, users = [entry()]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-access-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "access.json");
  await fs.writeFile(filename, JSON.stringify({ users }), { mode: 0o600 });
  return { root, filename };
}

test("access configuration stores hashes and accepts only private regular files", async (t) => {
  const { root, filename } = await accessFile(t);
  const [user] = loadAccess(filename, 2);
  assert.equal(user.id, "alice");
  assert.equal(user.token, undefined);
  assert(matches(entry().token, user.tokenHash));
  await fs.chmod(filename, 0o644);
  assert.throws(() => loadAccess(filename, 2), /owner-only/);
  await fs.chmod(filename, 0o600);
  const symlink = path.join(root, "linked.json");
  await fs.symlink(filename, symlink);
  assert.throws(() => loadAccess(symlink, 2), /regular, owner-only/);
  assert.throws(() => loadAccess(root, 2), /regular, owner-only/);
  await fs.writeFile(filename, "x".repeat(65537));
  assert.throws(() => loadAccess(filename, 2), /regular, owner-only/);
});

test("duplicate identities, shared operator tokens and invalid permissions are refused", async (t) => {
  const invalid = [
    [], [entry(), entry({ token: "B".repeat(43) })], [entry(), entry({ id: "bob" })],
    [entry({ id: "../alice" })], [entry({ id: 123 })], [entry({ id: ["alice"] })],
    [entry({ token: "short" })],
    [entry({ profiles: [] })], [entry({ profiles: ["admin"] })],
    [entry({ maxSessions: 0 })], [entry({ maxSessions: 3 })], [entry({ maxSessions: 1.5 })]
  ];
  const { filename } = await accessFile(t);
  for (const users of invalid) {
    await fs.writeFile(filename, JSON.stringify({ users }));
    assert.throws(() => loadAccess(filename, 2), /invalid|duplicate/);
  }
});

test("missing access configuration prevents configuration startup", () => {
  assert.throws(() => loadAccess(undefined, 2), /ACCESS_FILE is required/);
  const env = { ...process.env };
  delete env.ACCESS_FILE;
  const script = `await import(${JSON.stringify(new URL("../src/config.js", import.meta.url).href)})`;
  const processResult = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env, encoding: "utf8" });
  assert.notEqual(processResult.status, 0);
  assert.match(processResult.stderr, /ACCESS_FILE is required/);
});

test("bearer parsing and principal lookup reject malformed and unknown tokens", () => {
  const token = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(bearer({ headers: { authorization: `Bearer ${token}` } }), token);
  for (const authorization of [undefined, "Basic abc", "Bearer short", `Bearer ${token} extra`]) {
    assert.throws(() => bearer({ headers: { authorization } }), (error) => error.status === 401);
  }
  const users = [{ id: "alice", tokenHash: digest(token) }];
  assert.equal(principalFor(token, users).id, "alice");
  assert.equal(principalFor("Z".repeat(43), users), undefined);
  assert.equal(matches(undefined, users[0].tokenHash), false);
  assert.equal(matches("x".repeat(129), users[0].tokenHash), false);
});

test("rate limits cap both a caller and the number of tracked callers", () => {
  const limiter = new RateLimiter(2, 60000, 2);
  limiter.take("alice"); limiter.take("alice");
  assert.throws(() => limiter.take("alice"), (error) => error.status === 429);
  limiter.take("bob");
  assert.throws(() => limiter.take("charlie"), (error) => error.status === 429);
  limiter.entries.get("alice").reset = Date.now() - 1;
  assert.doesNotThrow(() => limiter.take("charlie"));
});
