import crypto from "node:crypto";
import { DouyinController } from "./douyin-controller.js";
import { digest, matches, newToken } from "./access.js";
import { HttpError } from "./errors.js";

export class SessionManager {
  constructor(config, slotManager, profileManager, browserManager, streamManager) {
    this.config = config;
    this.slots = slotManager;
    this.profiles = profileManager;
    this.browsers = browserManager;
    this.streams = streamManager;
    this.byId = new Map();
    this.pending = new Set();
    this.creating = new Map();
    this.shuttingDown = false;
  }

  async create(profileType, owner) {
    if (this.shuttingDown || this.unhealthy) throw new HttpError(503, "worker is unavailable");
    if (!owner.profiles.includes(profileType)) throw new HttpError(403, "profile is not permitted");
    const active = [...this.byId.values()].filter((s) => s.ownerId === owner.id).length;
    const pending = this.creating.get(owner.id) || 0;
    if (active + pending >= owner.maxSessions) throw new HttpError(409, "session limit reached");
    this.creating.set(owner.id, pending + 1);
    const task = this.createSession(profileType, owner);
    this.pending.add(task);
    try { return await task; }
    finally {
      this.pending.delete(task);
      this.creating.set(owner.id, this.creating.get(owner.id) - 1);
    }
  }

  async createSession(profileType, owner) {
    let slot;
    try { slot = this.slots.reserve(); }
    catch { throw new HttpError(503, "all browser slots are occupied"); }
    const id = crypto.randomUUID();
    let profile, resources, browser;
    try {
      profile = await this.profiles.acquire(profileType, slot, owner.id);
      resources = await this.streams.prepare(slot, id);
      browser = await this.browsers.launch(profile.profilePath, resources.display, resources.pulseSink, resources);
      const encoder = await this.streams.start(resources);
      if (this.shuttingDown || this.unhealthy) throw new HttpError(503, "worker is unavailable");
      const controlToken = newToken(), viewToken = newToken();
      const now = Date.now();
      const session = {
        id, slot, ownerId: owner.id, profile, browser, resources, encoder,
        controller: new DouyinController(browser.page, this.config.selectors),
        controlHash: digest(controlToken), viewHash: digest(viewToken),
        createdAt: now, lastHeartbeat: now,
        expiresAt: now + this.config.sessionTtlSeconds * 1000,
        viewExpiresAt: Math.min(now + this.config.viewTtlSeconds * 1000, now + this.config.sessionTtlSeconds * 1000),
        actionTail: Promise.resolve(), pendingActions: 0, closing: false
      };
      this.byId.set(id, session);
      this.slots.set(slot, session);
      return { session, controlToken, viewToken };
    } catch (error) {
      let cleanupFailed = error instanceof AggregateError;
      if (browser) await browser.context.close().catch(() => { cleanupFailed = true; });
      if (resources) await this.streams.stop(resources).catch(() => { cleanupFailed = true; });
      if (!cleanupFailed && profile) await this.profiles.release(profile).catch(() => { cleanupFailed = true; });
      // Never reuse a profile or slot while an old browser/encoder may still exist.
      if (cleanupFailed) this.unhealthy = true;
      else this.slots.release(slot);
      throw error;
    }
  }

  get(id, allowClosing = false) {
    const session = this.byId.get(id);
    if (!session || (!allowClosing && session.closing) || Date.now() >= session.expiresAt ||
        Date.now() - session.lastHeartbeat >= this.config.heartbeatTimeoutSeconds * 1000) {
      throw new HttpError(404, "session is not active");
    }
    return session;
  }

  authorize(id, token, principal, allowClosing = false) {
    const session = this.get(id, allowClosing);
    if (principal?.id !== session.ownerId && !matches(token, session.controlHash)) {
      throw new HttpError(404, "session is not active");
    }
    return session;
  }

  viewer(id, token) {
    const session = this.get(id);
    if (Date.now() >= session.viewExpiresAt || !matches(token, session.viewHash)) {
      throw new HttpError(404, "stream is not available");
    }
    return session;
  }

  share(id) {
    const session = this.get(id);
    const viewToken = newToken();
    session.viewHash = digest(viewToken);
    session.viewExpiresAt = Math.min(Date.now() + this.config.viewTtlSeconds * 1000, session.expiresAt);
    return { session, viewToken };
  }

  heartbeat(id) {
    const session = this.get(id);
    session.lastHeartbeat = Date.now();
  }

  action(id, action) {
    if (!["next", "prev", "like", "favorite"].includes(action)) throw new HttpError(400, "invalid action");
    const session = this.get(id);
    if (session.pendingActions >= 8) throw new HttpError(429, "action queue is full");
    session.lastHeartbeat = Date.now();
    session.pendingActions++;
    const task = session.actionTail.catch(() => {}).then(() => session.controller[action]())
      .finally(() => { session.pendingActions--; });
    session.actionTail = task;
    return task;
  }

  close(id, reason = "api") {
    const session = this.byId.get(id);
    if (!session) throw new HttpError(404, "session is not active");
    if (session.closePromise) return session.closePromise;
    session.closing = true;
    console.log(`closing session ${id}: ${reason}`);
    session.closePromise = (async () => {
      await session.actionTail.catch(() => {});
      const results = await Promise.allSettled([session.browser.context.close(), this.streams.stop(session.resources)]);
      if (results.some((result) => result.status === "rejected")) {
        this.unhealthy = true;
        throw new Error("worker cleanup incomplete; restart its isolated container");
      }
      try { await this.profiles.release(session.profile); }
      catch (error) { this.unhealthy = true; throw error; }
      this.byId.delete(id); this.slots.release(session.slot);
    })();
    return session.closePromise;
  }

  async sweepExpired() {
    const now = Date.now();
    const expired = [...this.byId.values()].filter((s) => now >= s.expiresAt || now - s.lastHeartbeat >= this.config.heartbeatTimeoutSeconds * 1000);
    await Promise.allSettled(expired.map((s) => this.close(s.id, "expired")));
  }

  async closeAll() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.pending]);
    const results = await Promise.allSettled([...this.byId.keys()].map((id) => this.close(id, "server shutdown")));
    if (this.unhealthy || results.some((result) => result.status === "rejected")) throw new Error("worker cleanup incomplete");
  }
}
