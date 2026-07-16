'use strict';

class AiQueue {
    constructor({ logger, concurrency = 2, dedupTtlMs = 60000, maxSize = 500 } = {}) {
        this.logger = logger;
        this.concurrency = Math.max(1, Number(concurrency) || 1);
        this.running = 0;
        this.queue = [];
        this.dedup = new Map();
        this.dedupTtlMs = Math.max(0, Number(dedupTtlMs) || 0);
        this.maxSize = Math.max(this.concurrency, Number(maxSize) || 500);
        this.closed = false;
    }

    enqueue(key, task, priority = 5) {
        if (this.closed) return false;
        if (typeof task !== 'function') throw new TypeError('AiQueue task must be a function');
        if (this.queue.length >= this.maxSize) {
            this.logger?.warn?.('[AiQueue] Queue capacity reached; task rejected');
            return false;
        }
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey) throw new TypeError('AiQueue key is required');
        const now = Date.now();
        for (const [seenKey, seenAt] of this.dedup) {
            if (now - seenAt >= this.dedupTtlMs) this.dedup.delete(seenKey);
        }
        const last = this.dedup.get(normalizedKey) || 0;
        if (now - last < this.dedupTtlMs) return false;
        this.dedup.set(normalizedKey, now);

        this.queue.push({ key: normalizedKey, task, priority: Number(priority) || 5, ts: now });
        this.queue.sort((a, b) => a.priority - b.priority || a.ts - b.ts);
        this._drain();
        return true;
    }

    _drain() {
        if (this.closed) return;
        while (this.running < this.concurrency && this.queue.length > 0) {
            const item = this.queue.shift();
            this.running += 1;
            Promise.resolve()
                .then(() => item.task())
                .catch((err) => this.logger?.warn?.(`[AiQueue] Task failed: ${err.message}`))
                .finally(() => {
                    this.running -= 1;
                    setImmediate(() => this._drain());
                });
        }
    }

    close({ discard = true } = {}) {
        this.closed = true;
        if (discard) this.queue.length = 0;
        this.dedup.clear();
    }
}

module.exports = { AiQueue };
