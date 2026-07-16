'use strict';

class RetryQueue {
    constructor({ logger, concurrency = 2, maxSize = 1000 } = {}) {
        this.logger = logger;
        this.concurrency = Math.max(1, Number(concurrency) || 1);
        this.maxSize = Math.max(this.concurrency, Number(maxSize) || 1000);
        this.items = [];
        this.running = 0;
        this.timer = null;
        this.closed = false;
    }

    push(task, { delayMs = 0, attempts = 3, backoffMs = 1000 } = {}) {
        if (this.closed) return false;
        if (typeof task !== 'function') throw new TypeError('RetryQueue task must be a function');
        if (this.items.length >= this.maxSize) {
            this.logger?.warn?.('[RetryQueue] Queue capacity reached; task rejected');
            return false;
        }
        this.items.push({
            task,
            attempts: Math.max(1, Number(attempts) || 1),
            backoffMs: Math.max(0, Number(backoffMs) || 0),
            runAt: Date.now() + Math.max(0, Number(delayMs) || 0),
        });
        this._drain();
        return true;
    }

    _nextReadyIndex() {
        const now = Date.now();
        return this.items.findIndex((item) => item.runAt <= now);
    }

    _schedule() {
        if (this.closed || this.timer || this.items.length === 0) return;
        const nextRunAt = Math.min(...this.items.map((item) => item.runAt));
        this.timer = setTimeout(() => {
            this.timer = null;
            this._drain();
        }, Math.max(0, nextRunAt - Date.now()));
        this.timer.unref?.();
    }

    _drain() {
        if (this.closed) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        while (this.running < this.concurrency) {
            const index = this._nextReadyIndex();
            if (index === -1) break;
            const item = this.items.splice(index, 1)[0];
            this.running += 1;
            Promise.resolve()
                .then(() => item.task())
                .catch((error) => {
                    if (!this.closed && item.attempts > 1 && this.items.length < this.maxSize) {
                        this.items.push({
                            task: item.task,
                            attempts: item.attempts - 1,
                            backoffMs: Math.min(item.backoffMs * 2, 30000),
                            runAt: Date.now() + item.backoffMs,
                        });
                    } else {
                        this.logger?.warn?.(`[RetryQueue] Dropped task: ${error.message}`);
                    }
                })
                .finally(() => {
                    this.running -= 1;
                    setImmediate(() => this._drain());
                });
        }
        this._schedule();
    }

    close({ discard = true } = {}) {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (discard) this.items.length = 0;
    }
}

module.exports = { RetryQueue };
