import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function lockDataRoot(dataRoot) {
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dataRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("data root must be a real directory");
  await fs.chmod(dataRoot, 0o700);
  const filename = path.join(dataRoot, ".worker-lock");
  const lease = crypto.randomUUID();
  try { await fs.writeFile(filename, `${lease}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("data root is locked; stop its worker before recovering a stale .worker-lock");
    throw error;
  }
  return async () => {
    if (await fs.readFile(filename, "utf8") === `${lease}\n`) await fs.unlink(filename);
  };
}
