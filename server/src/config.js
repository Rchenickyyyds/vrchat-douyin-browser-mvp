import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAccess } from "./access.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(serverRoot, "config", name), "utf8"));
const raw = readJson("default.json");

export const config = {
  ...raw,
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || raw.port),
  slotCount: Number(process.env.SLOT_COUNT || raw.slotCount),
  publicOrigin: process.env.PUBLIC_ORIGIN || "http://localhost:8080",
  proxyServer: process.env.BROWSER_PROXY_SERVER || undefined,
  dataRoot: path.resolve(serverRoot, process.env.DOUYIN_DATA_ROOT || raw.dataRoot),
  stream: {
    ...raw.stream,
    encoder: process.env.H264_ENCODER || raw.stream.encoder
  },
  selectors: readJson("selectors.json")
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
    !Number.isInteger(config.slotCount) || config.slotCount < 1 || config.slotCount > 16) {
  throw new Error("invalid PORT or SLOT_COUNT (1-16)");
}
const origin = new URL(config.publicOrigin);
if (origin.origin !== config.publicOrigin || origin.username || origin.password ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
  throw new Error("PUBLIC_ORIGIN must be an HTTPS origin, or HTTP localhost for local checks");
}
config.users = loadAccess(process.env.ACCESS_FILE, config.slotCount);
for (const name of ["sessionTtlSeconds", "viewTtlSeconds", "heartbeatTimeoutSeconds", "heartbeatSweepSeconds"]) {
  if (!Number.isInteger(config[name]) || config[name] < 1 || config[name] > 86400) throw new Error(`invalid ${name}`);
}
if (config.viewTtlSeconds > config.sessionTtlSeconds) throw new Error("view lifetime must not exceed session lifetime");
