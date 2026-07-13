'use strict';
// modules/messagePurge.js
// ─── MESSAGE PURGE SYSTEM (Ring Buffer) ─────────────────────────────────────
//
// Tracks the last N messages per group in a fixed-size ring buffer.
// Used by anti-delete (antiRevoke) to re-send deleted messages.
// Zero disk I/O on the hot path — everything is in-memory.
//
// Config:
//   PURGE_RING_SIZE  — max messages per group (default 100)
//   PURGE_TTL_MS     — max age of a message record (default 2hr)

const logger = require('../core/logger');

const RING_SIZE = Math.max(10, Number(process.env.PURGE_RING_SIZE || 100));
const TTL_MS    = Math.max(60000, Number(process.env.PURGE_TTL_MS || 2 * 60 * 60 * 1000));

// Map<groupJid, RingBuffer>
// RingBuffer is a fixed-size circular array of MessageRecord
const _rings = new Map();

// Cleanup expired entries every 5 minutes
const _cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [grp, ring] of _rings.entries()) {
        ring.cleanup(now - TTL_MS);
        if (ring.size() === 0) _rings.delete(grp);
    }
}, 5 * 60 * 1000).unref();

// ─── Ring Buffer ──────────────────────────────────────────────────────────────
class RingBuffer {
    constructor(capacity) {
        this._cap  = capacity;
        this._buf  = new Array(capacity);
        this._head = 0; // next write position
        this._count = 0;
    }

    push(item) {
        this._buf[this._head] = item;
        this._head = (this._head + 1) % this._cap;
        if (this._count < this._cap) this._count++;
    }

    size() { return this._count; }

    // Iterate oldest to newest
    *[Symbol.iterator]() {
        if (this._count < this._cap) {
            for (let i = 0; i < this._count; i++) yield this._buf[i];
        } else {
            for (let i = 0; i < this._cap; i++) {
                yield this._buf[(this._head + i) % this._cap];
            }
        }
    }

    findById(msgId) {
        for (const item of this) {
            if (item && item.msgId === msgId) return item;
        }
        return null;
    }

    cleanup(olderThanMs) {
        // Replace expired items with undefined
        for (let i = 0; i < this._cap; i++) {
            const item = this._buf[i];
            if (item && item.ts < olderThanMs) this._buf[i] = undefined;
        }
        // Recount
        this._count = this._buf.filter(Boolean).length;
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * trackMessage — add a message to the ring buffer for its group.
 * Call this for every incoming message.
 */
function trackMessage(groupJid, msgId, senderJid, content, metadata = {}) {
    const g = String(groupJid || '').trim();
    const m = String(msgId || '').trim();
    if (!g || !m) return;

    if (!_rings.has(g)) _rings.set(g, new RingBuffer(RING_SIZE));
    _rings.get(g).push({
        msgId:     m,
        groupJid:  g,
        senderJid: String(senderJid || ''),
        content,
        metadata,
        ts:        Date.now(),
    });
}

/**
 * getTrackedMessage — retrieve a message by ID from a group's ring.
 * Returns null if not found or expired.
 */
function getTrackedMessage(groupJid, msgId) {
    const g = String(groupJid || '').trim();
    const m = String(msgId || '').trim();
    if (!g || !m) return null;

    const ring = _rings.get(g);
    if (!ring) return null;

    const record = ring.findById(m);
    if (!record) return null;

    // Check TTL
    if (Date.now() - record.ts > TTL_MS) return null;
    return record;
}

/**
 * listGroupMessages — get all tracked messages for a group (for bulk purge).
 */
function listGroupMessages(groupJid) {
    const g = String(groupJid || '').trim();
    const ring = _rings.get(g);
    if (!ring) return [];
    const now = Date.now();
    const results = [];
    for (const item of ring) {
        if (item && now - item.ts <= TTL_MS) results.push(item);
    }
    return results;
}

/**
 * purgeGroup — delete all tracked messages for a group using WA sock.
 * Typically called by an admin command to mass-delete bot messages.
 */
async function purgeGroup(groupJid, sock, filter = null) {
    const g = String(groupJid || '').trim();
    if (!g || !sock?.sendMessage) return { purged: 0, failed: 0 };

    const messages = listGroupMessages(g);
    const toDelete = filter ? messages.filter(filter) : messages;

    let purged = 0, failed = 0;
    const DELAY_MS = 400;

    for (const record of toDelete) {
        try {
            await sock.sendMessage(g, {
                delete: {
                    remoteJid: g,
                    fromMe:    true,
                    id:        record.msgId,
                    participant: record.senderJid,
                },
            });
            purged++;
            if (purged % 5 === 0) await new Promise(r => setTimeout(r, DELAY_MS));
        } catch {
            failed++;
        }
    }

    // Clear ring after purge
    _rings.delete(g);
    return { purged, failed, total: toDelete.length };
}

/**
 * clearGroup — discard ring buffer for a group (on bot leave, etc.).
 */
function clearGroup(groupJid) {
    _rings.delete(String(groupJid || '').trim());
}

/**
 * stats — basic memory stats.
 */
function stats() {
    let total = 0;
    for (const ring of _rings.values()) total += ring.size();
    return { groups: _rings.size, messages: total, ringSize: RING_SIZE, ttlMs: TTL_MS };
}

module.exports = {
    trackMessage,
    getTrackedMessage,
    listGroupMessages,
    purgeGroup,
    clearGroup,
    stats,
};
