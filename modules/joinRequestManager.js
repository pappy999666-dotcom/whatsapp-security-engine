'use strict';
// modules/joinRequestManager.js
// ─── JOIN REQUEST APPROVAL SYSTEM ────────────────────────────────────────────
//
// Manages group join-request approval / rejection queues.
// Persists pending requests to disk; in-memory Map for fast access on hot path.
//
// Contract:
//  • addRequest(groupJid, requesterJid, meta) — enqueue for review
//  • approveRequest(groupJid, requesterJid, sock) — call WA acceptGroupJoinRequest
//  • rejectRequest(groupJid, requesterJid, sock)  — call WA rejectGroupJoinRequest
//  • autoApproveAll(groupJid, sock)               — bulk approve all pending
//  • autoRejectAll(groupJid, sock)                — bulk reject all pending
//  • getPendingCount(groupJid)                    — how many pending
//  • listPending(groupJid)                        — list JIDs pending

const fs   = require('fs');
const path = require('path');
const logger = require('../core/logger');

const DATA_DIR = path.join(__dirname, '../data');
const FILE     = path.join(DATA_DIR, 'join-requests.json');

// ─── In-memory store: Map<groupJid, Map<requesterJid, RequestRecord>> ─────────
const _store = new Map();
let _loaded  = false;
let _flushTimer = null;
let _flushLock  = false;

// ─── Disk I/O ─────────────────────────────────────────────────────────────────
function _load() {
    if (_loaded) return;
    _loaded = true;
    try {
        if (!fs.existsSync(FILE)) return;
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}');
        for (const [grp, requests] of Object.entries(raw)) {
            const m = new Map();
            for (const [jid, rec] of Object.entries(requests)) m.set(jid, rec);
            _store.set(grp, m);
        }
    } catch (e) {
        logger.warn(`[JoinRequestManager] load error: ${e.message}`);
    }
}

async function _flush() {
    if (_flushLock) return;
    _flushLock = true;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const payload = {};
        for (const [grp, m] of _store.entries()) {
            const r = {};
            for (const [jid, rec] of m.entries()) r[jid] = rec;
            payload[grp] = r;
        }
        const tmp = `${FILE}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2));
        await fs.promises.rename(tmp, FILE);
    } catch (e) {
        logger.warn(`[JoinRequestManager] flush error: ${e.message}`);
    } finally {
        _flushLock = false;
    }
}

function _scheduleSave() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => { _flushTimer = null; _flush().catch(() => {}); }, 600);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
async function _requestUpdate(sock, groupJid, requesterJids, action) {
    const list = Array.isArray(requesterJids) ? requesterJids : [requesterJids];
    if (typeof sock?.groupRequestParticipantsUpdate === 'function') {
        return sock.groupRequestParticipantsUpdate(groupJid, list, action);
    }
    if (action === 'approve' && typeof sock?.groupApproveJoinRequest === 'function') {
        return sock.groupApproveJoinRequest(groupJid, list);
    }
    if (action === 'reject' && typeof sock?.groupRejectJoinRequest === 'function') {
        return sock.groupRejectJoinRequest(groupJid, list);
    }
    throw new Error('join_request_api_unavailable');
}

function _groupMap(groupJid) {
    _load();
    const g = String(groupJid || '').trim();
    if (!_store.has(g)) _store.set(g, new Map());
    return _store.get(g);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * addRequest — record a pending join request.
 */
function addRequest(groupJid, requesterJid, meta = {}) {
    const g = String(groupJid || '').trim();
    const r = String(requesterJid || '').trim();
    if (!g || !r) return false;
    const m = _groupMap(g);
    if (m.has(r)) return false; // already queued
    m.set(r, { jid: r, groupJid: g, addedAt: Date.now(), ...meta });
    _scheduleSave();
    return true;
}

/**
 * approveRequest — approve a single pending request.
 */
async function approveRequest(groupJid, requesterJid, sock) {
    const g = String(groupJid || '').trim();
    const r = String(requesterJid || '').trim();
    if (!g || !r || !sock) return { ok: false, error: 'invalid_args' };

    const m = _groupMap(g);
    if (!m.has(r)) return { ok: false, error: 'not_pending' };

    try {
        await _requestUpdate(sock, g, [r], 'approve');
        m.delete(r);
        _scheduleSave();
        logger.info(`[JoinRequestManager] approved ${r} → ${g}`);
        return { ok: true };
    } catch (err) {
        logger.warn(`[JoinRequestManager] approve error ${r}→${g}: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/**
 * rejectRequest — reject a single pending request.
 */
async function rejectRequest(groupJid, requesterJid, sock) {
    const g = String(groupJid || '').trim();
    const r = String(requesterJid || '').trim();
    if (!g || !r || !sock) return { ok: false, error: 'invalid_args' };

    const m = _groupMap(g);
    if (!m.has(r)) return { ok: false, error: 'not_pending' };

    try {
        await _requestUpdate(sock, g, [r], 'reject');
        m.delete(r);
        _scheduleSave();
        logger.info(`[JoinRequestManager] rejected ${r} → ${g}`);
        return { ok: true };
    } catch (err) {
        logger.warn(`[JoinRequestManager] reject error ${r}→${g}: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/**
 * autoApproveAll — bulk approve every pending request in a group.
 * Returns { approved, failed, total }
 */
async function autoApproveAll(groupJid, sock) {
    const g = String(groupJid || '').trim();
    if (!g || !sock) return { approved: 0, failed: 0, total: 0 };

    const m = _groupMap(g);
    const pending = Array.from(m.keys());
    if (!pending.length) return { approved: 0, failed: 0, total: 0 };

    let approved = 0, failed = 0;
    // Process in batches of 20 to avoid WA rate limits
    const BATCH = 20;
    for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        try {
            await _requestUpdate(sock, g, batch, 'approve');
            for (const jid of batch) m.delete(jid);
            approved += batch.length;
        } catch (err) {
            failed += batch.length;
            logger.warn(`[JoinRequestManager] bulk-approve batch error: ${err.message}`);
        }
        if (i + BATCH < pending.length) await new Promise(r => setTimeout(r, 1200));
    }

    _scheduleSave();
    logger.info(`[JoinRequestManager] autoApproveAll ${g}: ${approved}/${pending.length}`);
    return { approved, failed, total: pending.length };
}

/**
 * autoRejectAll — bulk reject every pending request in a group.
 */
async function autoRejectAll(groupJid, sock) {
    const g = String(groupJid || '').trim();
    if (!g || !sock) return { rejected: 0, failed: 0, total: 0 };

    const m = _groupMap(g);
    const pending = Array.from(m.keys());
    if (!pending.length) return { rejected: 0, failed: 0, total: 0 };

    let rejected = 0, failed = 0;
    const BATCH = 20;
    for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        try {
            await _requestUpdate(sock, g, batch, 'reject');
            for (const jid of batch) m.delete(jid);
            rejected += batch.length;
        } catch (err) {
            failed += batch.length;
            logger.warn(`[JoinRequestManager] bulk-reject batch error: ${err.message}`);
        }
        if (i + BATCH < pending.length) await new Promise(r => setTimeout(r, 1200));
    }

    _scheduleSave();
    return { rejected, failed, total: pending.length };
}

/**
 * getPendingCount — how many requests are pending for a group.
 */
function getPendingCount(groupJid) {
    _load();
    const g = String(groupJid || '').trim();
    return _store.get(g)?.size ?? 0;
}

/**
 * listPending — list all pending requester JIDs for a group.
 */
function listPending(groupJid) {
    _load();
    const g = String(groupJid || '').trim();
    const m = _store.get(g);
    if (!m) return [];
    return Array.from(m.values());
}

/**
 * clearGroup — remove all records for a group (e.g., bot left group).
 */
function clearGroup(groupJid) {
    const g = String(groupJid || '').trim();
    if (!g || !_store.has(g)) return;
    _store.delete(g);
    _scheduleSave();
}

/**
 * init — warm cache from disk.
 */
function init() {
    _load();
    const total = Array.from(_store.values()).reduce((sum, m) => sum + m.size, 0);
    logger.info(`[JoinRequestManager] ready — ${total} pending request(s) across ${_store.size} group(s)`);
}

module.exports = {
    init,
    addRequest,
    approveRequest,
    rejectRequest,
    autoApproveAll,
    autoRejectAll,
    getPendingCount,
    listPending,
    clearGroup,
};
