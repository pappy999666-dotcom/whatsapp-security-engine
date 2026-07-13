'use strict';
// modules/waSocketRegistry.js
// ─── WA SOCKET REGISTRY — Module singleton replacing global.waSocks ───────────
//
// All code should import from this module rather than reading global.waSocks.
// Provides O(1) lookups by sessionKey and by botId (phone number).
//
// Migration: global.waSocks is kept in sync for legacy compatibility until all
// callers are updated to use this registry.

const logger = require('../core/logger');

// Map<sessionKey, WASocket>   — primary key is the session folder name
const _sockets = new Map();

// Map<botId, sessionKey>      — secondary index for fast botId → socket lookup
const _botIndex = new Map();

// ─── Registry operations ─────────────────────────────────────────────────────

/**
 * register — add or replace a socket in the registry.
 * sessionKey format: "<chatId>_<phone>_<slot>"
 */
function register(sessionKey, sock) {
    const key = String(sessionKey || '').trim();
    if (!key || !sock) return false;

    _sockets.set(key, sock);

    // Index by phone/botId extracted from sessionKey (e.g. "12345678_234567890_1" → "234567890")
    const phone = _extractBotId(key);
    if (phone) _botIndex.set(phone, key);

    // Sync legacy global
    try { if (global.waSocks) global.waSocks.set(key, sock); } catch {}

    return true;
}

/**
 * unregister — remove a socket from the registry.
 */
function unregister(sessionKey) {
    const key = String(sessionKey || '').trim();
    if (!key) return false;

    _sockets.delete(key);

    // Remove from bot index
    for (const [botId, sk] of _botIndex.entries()) {
        if (sk === key) { _botIndex.delete(botId); break; }
    }

    // Sync legacy global
    try { if (global.waSocks) global.waSocks.delete(key); } catch {}

    return true;
}

/**
 * getByKey — retrieve socket by session key.
 */
function getByKey(sessionKey) {
    return _sockets.get(String(sessionKey || '').trim()) ?? null;
}

/**
 * getByBotId — retrieve socket by bot phone / JID.
 * Accepts "2348012345678", "2348012345678@s.whatsapp.net", or botId suffix.
 */
function getByBotId(botId) {
    const id = String(botId || '').replace(/@.+$/, '').replace(/[^0-9]/g, '');
    if (!id) return null;

    // Primary: botIndex exact match
    const key = _botIndex.get(id);
    if (key && _sockets.has(key)) return _sockets.get(key);

    // Fallback: scan (slower but handles partial matches)
    for (const [sk, sock] of _sockets.entries()) {
        if (sk.includes(id)) {
            _botIndex.set(id, sk); // cache the match
            return sock;
        }
    }
    return null;
}

/**
 * getAll — snapshot of all registered sockets.
 * Returns a new Map to prevent external mutation.
 */
function getAll() {
    return new Map(_sockets);
}

/**
 * listKeys — array of all active session keys.
 */
function listKeys() {
    return Array.from(_sockets.keys());
}

/**
 * size — count of registered sockets.
 */
function size() {
    return _sockets.size;
}

/**
 * clear — remove all sockets (used in testing / full restart).
 */
function clear() {
    _sockets.clear();
    _botIndex.clear();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _extractBotId(sessionKey) {
    // Format: "<chatId>_<phone>_<slot>" or "<phone>_<slot>" or "<phone>"
    const parts = sessionKey.split('_');
    // phone is the last numeric segment that looks like a real phone number (7-15 digits)
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i].replace(/[^0-9]/g, '');
        if (p.length >= 7 && p.length <= 15) return p;
    }
    return sessionKey;
}

// Ensure global.waSocks is in sync on startup (legacy bootstrap)
function syncFromGlobal() {
    if (!global.waSocks) return;
    for (const [key, sock] of global.waSocks.entries()) {
        if (!_sockets.has(key)) register(key, sock);
    }
}

// Expose the raw Map for legacy callers that mutate global.waSocks directly
// (to be deprecated progressively)
Object.defineProperty(module.exports, '_rawMap', { get: () => _sockets });

module.exports = {
    register,
    unregister,
    getByKey,
    getByBotId,
    getAll,
    listKeys,
    size,
    clear,
    syncFromGlobal,
};
