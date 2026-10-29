import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const PROFILE_NAMES = {
  user1: "profile_user_1",
  user2: "profile_user_2"
};

export class ProfileManager {
  constructor(dataRoot) {
    this.profilesRoot = path.join(dataRoot, "profiles");
    this.guestsRoot = path.join(dataRoot, "guest-profiles");
    this.lockedPermanentProfiles = new Set();
  }

  async initialize() {
    await fs.mkdir(this.profilesRoot, { recursive: true });
    await fs.rm(this.guestsRoot, { recursive: true, force: true });
    await fs.mkdir(this.guestsRoot, { recursive: true });
  }

  async acquire(profileType, slot) {
    if (profileType === "guest") {
      const profilePath = path.join(this.guestsRoot, `slot-${slot}-${crypto.randomUUID()}`);
      await fs.mkdir(profilePath, { recursive: true });
      return { profileType, profilePath, persistent: false };
    }

    const profileName = PROFILE_NAMES[profileType];
    if (!profileName) throw new Error("profile must be user1, user2, or guest");
    if (this.lockedPermanentProfiles.has(profileName)) {
      throw new Error(`${profileName} is already active in another instance`);
    }

    this.lockedPermanentProfiles.add(profileName);
    const profilePath = path.join(this.profilesRoot, profileName);
    try {
      await fs.mkdir(profilePath, { recursive: true });
      return { profileType, profilePath, persistent: true, profileName };
    } catch (error) {
      this.lockedPermanentProfiles.delete(profileName);
      throw error;
    }
  }

  async release(profile) {
    if (profile.persistent) {
      this.lockedPermanentProfiles.delete(profile.profileName);
      return;
    }

    const relative = path.relative(this.guestsRoot, profile.profilePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to delete unsafe guest profile path: ${profile.profilePath}`);
    }
    await fs.rm(profile.profilePath, { recursive: true, force: true });
  }
}
