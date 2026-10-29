import { config } from "./config.js";
import { ProfileManager } from "./profile-manager.js";
import { SlotManager } from "./slot-manager.js";
import { BrowserManager } from "./browser-manager.js";
import { StreamManager } from "./stream-manager.js";
import { SessionManager } from "./session-manager.js";
import { createApi } from "./api.js";
import { lockDataRoot } from "./data-lock.js";

process.umask(0o077);
const unlock = await lockDataRoot(config.dataRoot);
const profiles = new ProfileManager(config.dataRoot);
const slots = new SlotManager(config.slotCount);
const streams = new StreamManager(config);
try {
  await profiles.initialize();
  await streams.initialize();
} catch (error) {
  await unlock();
  throw error;
}

const sessions = new SessionManager(config, slots, profiles, new BrowserManager(config), streams);
const server = createApi(config, sessions);
server.listen(config.port, config.host, () => console.log(`Douyin browser server listening on ${config.host}:${config.port}`));
server.once("error", () => { shutdown("listen error"); });

const sweepTimer = setInterval(
  () => sessions.sweepExpired().catch(console.error),
  config.heartbeatSweepSeconds * 1000
);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}`);
  clearInterval(sweepTimer);
  server.close();
  try {
    await sessions.closeAll();
    await unlock();
    process.exit(signal === "listen error" ? 1 : 0);
  } catch {
    console.error("worker cleanup incomplete; data lock retained");
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
