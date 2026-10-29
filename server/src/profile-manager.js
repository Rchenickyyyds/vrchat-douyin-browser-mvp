import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { HttpError } from "./errors.js";

const PROFILE_NAMES = {
  user1: "profile_user_1",
  user2: "profile_user_2"
};

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe profile directory");
  await fs.chmod(directory, 0o700);
}

export class ProfileManager {
  constructor(dataRoot) {
    this.profilesRoot = path.join(dataRoot, "profiles");
    this.guestsRoot = path.join(dataRoot, "guest-profiles");
    this.lockedPermanentProfiles = new Set();
  }

  async initialize() {
    await privateDirectory(this.profilesRoot);
    await fs.rm(this.guestsRoot, { recursive: true, force: true });
    await privateDirectory(this.guestsRoot);
  }

  async acquire(profileType, slot, ownerId) {
    if (typeof ownerId !== "string" || !ownerId || ownerId.length > 128) throw new Error("invalid profile owner");
    if (profileType === "guest") {
      const profilePath = path.join(this.guestsRoot, `slot-${slot}-${crypto.randomUUID()}`);
      await privateDirectory(profilePath);
      return { profileType, profilePath, persistent: false };
    }

    const profileName = PROFILE_NAMES[profileType];
    if (!profileName) throw new Error("profile must be user1, user2, or guest");
    const owner = crypto.createHash("sha256").update(ownerId).digest("hex");
    const lockKey = `${owner}/${profileName}`;
    if (this.lockedPermanentProfiles.has(lockKey)) {
      throw new HttpError(409, `${profileName} is already active in another instance`);
    }

    this.lockedPermanentProfiles.add(lockKey);
    const ownerPath = path.join(this.profilesRoot, owner);
    const profilePath = path.join(ownerPath, profileName);
    try {
      await privateDirectory(ownerPath);
      await privateDirectory(profilePath);
      return { profileType, profilePath, persistent: true, profileName, lockKey };
    } catch (error) {
      this.lockedPermanentProfiles.delete(lockKey);
      throw error;
    }
  }

  async release(profile) {
    if (profile.persistent) {
      this.lockedPermanentProfiles.delete(profile.lockKey);
      return;
    }

    const relative = path.relative(this.guestsRoot, profile.profilePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to delete unsafe guest profile path: ${profile.profilePath}`);
    }
    await fs.rm(profile.profilePath, { recursive: true, force: true });
  }
}
