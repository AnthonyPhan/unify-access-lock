export class EventDeduplicator {
  constructor({ ttlMs = 10 * 60_000, maxEntries = 10_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.seen = new Map();
  }

  isDuplicate(id) {
    if (!id) return false;
    const now = this.now();
    const previous = this.seen.get(id);
    if (previous !== undefined && now - previous <= this.ttlMs) return true;

    this.seen.set(id, now);
    if (this.seen.size > this.maxEntries) this.prune(now);
    return false;
  }

  prune(now = this.now()) {
    for (const [id, seenAt] of this.seen) {
      if (now - seenAt > this.ttlMs || this.seen.size > this.maxEntries) this.seen.delete(id);
    }
  }
}
