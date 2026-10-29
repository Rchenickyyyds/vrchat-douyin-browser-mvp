export class SlotManager {
  constructor(slotCount) {
    // ponytail: single-process leases; use a database lock before running multiple API replicas.
    this.sessions = new Array(slotCount).fill(null);
  }

  reserve() {
    const slot = this.sessions.indexOf(null);
    if (slot === -1) throw new Error("all browser slots are occupied");
    this.sessions[slot] = { reserving: true };
    return slot;
  }

  set(slot, session) {
    this.assertSlot(slot);
    this.sessions[slot] = session;
  }

  get(slot) {
    this.assertSlot(slot);
    const session = this.sessions[slot];
    if (!session || session.reserving) throw new Error(`slot ${slot} is not active`);
    return session;
  }

  release(slot) {
    this.assertSlot(slot);
    this.sessions[slot] = null;
  }

  active() {
    return this.sessions.filter((session) => session && !session.reserving);
  }

  assertSlot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.sessions.length) {
      throw new Error("invalid slot");
    }
  }
}
