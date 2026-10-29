import { config } from "./config.js";
import { ProfileManager } from "./profile-manager.js";
import { SlotManager } from "./slot-manager.js";
import { BrowserManager } from "./browser-manager.js";
import { StreamManager } from "./stream-manager.js";
import { SessionManager } from "./session-manager.js";
import { createApi } from "./api.js";

const profiles = new ProfileManager(config.dataRoot);
const slots = new SlotManager(config.slotCount);
const streams = new StreamManager(config);
await profiles.initialize();
await streams.initialize();

const sessions = new SessionManager(config, slots, profiles, new BrowserManager(config), streams);
const server = createApi(config, sessions);
server.listen(config.port, config.host, () => console.log(`Douyin browser server listening on ${config.host}:${config.port}`));

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
  await sessions.closeAll();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
