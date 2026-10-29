import { DouyinController } from "./douyin-controller.js";

export class SessionManager {
  constructor(config, slotManager, profileManager, browserManager, streamManager) {
    this.config = config;
    this.slots = slotManager;
    this.profiles = profileManager;
    this.browsers = browserManager;
    this.streams = streamManager;
  }

  async create(profileType) {
    const slot = this.slots.reserve();
    let profile;
    let browser;
    let resources;
    try {
      profile = await this.profiles.acquire(profileType, slot);
      resources = await this.streams.prepare(slot);
      browser = await this.browsers.launch(profile.profilePath, resources.display, resources.pulseSink);
      const encoder = await this.streams.start(resources);
      const session = {
        slot,
        profile,
        browser,
        resources,
        controller: new DouyinController(browser.page, this.config.selectors),
        encoder,
        createdAt: Date.now(),
        lastHeartbeat: Date.now(),
        actionTail: Promise.resolve(),
        closing: false
      };
      this.slots.set(slot, session);
      return session;
    } catch (error) {
      if (browser) await browser.context.close().catch(() => {});
      if (resources) await this.streams.stop(resources).catch(() => {});
      if (profile) await this.profiles.release(profile).catch(() => {});
      this.slots.release(slot);
      throw error;
    }
  }

  heartbeat(slot) {
    const session = this.slots.get(slot);
    session.lastHeartbeat = Date.now();
    return session;
  }

  action(slot, action) {
    if (!["next", "prev", "like", "favorite"].includes(action)) throw new Error("invalid action");
    const session = this.heartbeat(slot);
    const task = session.actionTail.catch(() => {}).then(() => session.controller[action]());
    session.actionTail = task;
    return task;
  }

  async close(slot, reason = "api") {
    const session = this.slots.get(slot);
    if (session.closing) return;
    session.closing = true;
    console.log(`closing slot ${slot}: ${reason}`);
    await session.actionTail.catch(() => {});
    await session.browser.context.close().catch(() => {});
    await this.streams.stop(session.resources).catch((error) => console.error(error));
    try {
      await this.profiles.release(session.profile);
    } finally {
      this.slots.release(slot);
    }
  }

  async sweepExpired() {
    const cutoff = Date.now() - this.config.heartbeatTimeoutSeconds * 1000;
    const expired = this.slots.active().filter((session) => session.lastHeartbeat < cutoff);
    await Promise.allSettled(expired.map((session) => this.close(session.slot, "heartbeat timeout")));
  }

  async closeAll() {
    await Promise.allSettled(this.slots.active().map((session) => this.close(session.slot, "server shutdown")));
  }
}
