import fs from "node:fs/promises";
import path from "node:path";
import { newToken } from "../src/access.js";

process.umask(0o077);
const [filename = "secrets/access.json", id = "operator", grants = "guest"] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || grants.split(",").some((p) => !["guest", "user1", "user2"].includes(p))) {
  throw new Error("usage: node scripts/create-access.mjs [file] [operator-id] [guest,user1,user2]");
}
await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
await fs.writeFile(filename, JSON.stringify({ users: [{ id, token: newToken(), profiles: grants.split(","), maxSessions: 1 }] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(`Created owner-only access file: ${path.resolve(filename)}. Read it privately; do not commit or share its token.`);
