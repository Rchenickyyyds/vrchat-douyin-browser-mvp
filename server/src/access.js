import crypto from "node:crypto";
import fs from "node:fs";
import { HttpError } from "./errors.js";

export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const digest = (value) => crypto.createHash("sha256").update(value).digest();
export const matches = (value, expected) => typeof value === "string" &&
  value.length <= 128 && crypto.timingSafeEqual(digest(value), expected);

export function loadAccess(filename, slotCount) {
  if (!filename) throw new Error("ACCESS_FILE is required; run node scripts/create-access.mjs first");
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o077)) {
    throw new Error("ACCESS_FILE must be a regular, owner-only file (chmod 600)");
  }
  const entries = JSON.parse(fs.readFileSync(filename, "utf8")).users;
  if (!Array.isArray(entries) || !entries.length || entries.length > 32) throw new Error("invalid access users");
  const ids = new Set(), tokens = new Set();
  return entries.map(({ id, token, profiles, maxSessions = 1 }) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id) ||
        typeof token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(token) || tokens.has(token) ||
        !Array.isArray(profiles) || !profiles.length || profiles.some((p) => !["guest", "user1", "user2"].includes(p)) ||
        !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > slotCount) {
      throw new Error("invalid or duplicate access entry");
    }
    ids.add(id); tokens.add(token);
    return { id, tokenHash: digest(token), profiles, maxSessions };
  });
}

export function bearer(request) {
  const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/);
  if (!match) throw new HttpError(401, "bearer token required");
  return match[1];
}

export function principalFor(token, users) {
  return users.find((user) => matches(token, user.tokenHash));
}

export class RateLimiter {
  constructor(limit, windowMs, capacity = 4096) {
    this.limit = limit; this.windowMs = windowMs; this.capacity = capacity;
    this.entries = new Map();
  }

  take(key) {
    const now = Date.now();
    for (const [id, item] of this.entries) if (item.reset <= now) this.entries.delete(id);
    let item = this.entries.get(key);
    if (!item) {
      if (this.entries.size >= this.capacity) throw new HttpError(429, "request limit reached");
      item = { count: 0, reset: now + this.windowMs };
      this.entries.set(key, item);
    }
    if (++item.count > this.limit) throw new HttpError(429, "request limit reached");
  }
}
