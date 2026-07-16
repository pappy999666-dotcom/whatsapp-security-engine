'use strict';

class MediaQueue {
    constructor({ logger, concurrency = 3, maxSize = 250 } = {}) {
        this.logger = logger;
        this.concurrency = Math.max(1, Number(concurrency) || 1);
        this.maxSize = Math.max(this.concurrency, Number(maxSize) || 250);
        this.running = 0;
        this.queue = [];
        this.closed = false;
    }

    enqueue(task, priority = 5) {
        if (this.closed) return false;
        if (typeof task !== 'function') throw new TypeError('MediaQueue task must be a function');
        if (this.queue.length >= this.maxSize) {
            this.logger?.warn?.('[MediaQueue] Queue capacity reached; task rejected');
            return false;
        }
        this.queue.push({ task, priority: Number(priority) || 5, ts: Date.now() });
        this.queue.sort((a, b) => a.priority - b.priority || a.ts - b.ts);
        this._drain();
        return true;
    }

    _drain() {
        if (this.closed) return;
        while (this.running < this.concurrency && this.queue.length) {
            const next = this.queue.shift();
            this.running += 1;
            Promise.resolve()
                .then(() => next.task())
                .catch((err) => this.logger?.warn?.(`[MediaQueue] Task failed: ${err.message}`))
                .finally(() => {
                    this.running -= 1;
                    setImmediate(() => this._drain());
                });
        }
    }

    close({ discard = true } = {}) {
        this.closed = true;
        if (discard) this.queue.length = 0;
    }
}

module.exports = { MediaQueue };
