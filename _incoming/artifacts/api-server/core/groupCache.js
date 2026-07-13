// core/groupCache.js
// Centralized group metadata cache — single source of truth for all plugins
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CACHE_FILE = path.join(__dirname, '../data/group_meta_cache.json');
const TTL_MS     = 45 * 60 * 1000; // 45 min
const MAX_ENTRIES = 2000;
const WARMUP_COOLDOWN_MS = 20 * 60 * 1000;

// In-memory store: botId -> Map<jid, { data, ts }>
const _caches = new Map(); // per-bot cache
let _savePending = false;
let _loadPromise = null;
const _warmupState = new Map(); // botId -> { at, running }

function _getCache(sock) {
    const botId = String(sock?.user?.id?.split(':')[0] || 'global');
    if (!_caches.has(botId)) _caches.set(botId, new Map());
    return { cache: _caches.get(botId), botId };
}

// ── Load from disk on startup ──────────────────────────────────────────────
async function _load() {
    try {
        const rawText = await fs.promises.readFile(CACHE_FILE, 'utf8').catch(() => '');
        if (!rawText) return;
        const raw = JSON.parse(rawText);
        const now = Date.now();
        let loaded = 0;
        for (const [botId, groups] of Object.entries(raw || {})) {
            if (typeof groups !== 'object') continue;
            const cache = new Map();
            for (const [jid, entry] of Object.entries(groups)) {
                if (entry?.ts && (now - entry.ts) < TTL_MS) { cache.set(jid, entry); loaded++; }
            }
            if (cache.size > 0) _caches.set(botId, cache);
        }
        if (loaded > 0) logger.info(`[GroupCache] Loaded ${loaded} groups from disk`);
    } catch (e) {
        logger.warn(`[GroupCache] Failed to load cache: ${e.message}`);
    }
}

// ── Persist to disk (debounced 3s) ────────────────────────────────────────
function _persist() {
    if (_savePending) return;
    _savePending = true;
    setTimeout(async () => {
        try {
            const obj = {};
            for (const [botId, cache] of _caches.entries()) {
                obj[botId] = {};
                for (const [jid, entry] of cache.entries()) obj[botId][jid] = entry;
            }
            await fs.promises.mkdir(path.dirname(CACHE_FILE), { recursive: true });
            await fs.promises.writeFile(CACHE_FILE, JSON.stringify(obj));
        } catch (e) {
            logger.warn(`[GroupCache] Failed to persist: ${e.message}`);
        } finally {
            _savePending = false;
        }
    }, 3000);
}

// ── Evict expired + overflow entries ─────────────────────────────────────
function _evict() {
    const now = Date.now();
    for (const [, cache] of _caches.entries()) {
        for (const [jid, entry] of cache.entries()) {
            if (!entry?.ts || (now - entry.ts) >= TTL_MS) cache.delete(jid);
        }
        if (cache.size > MAX_ENTRIES) {
            const sorted = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
            sorted.slice(0, cache.size - MAX_ENTRIES).forEach(([jid]) => cache.delete(jid));
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Get group metadata — returns cache if fresh, otherwise fetches from WA.
 * @param {object} sock - Baileys socket
 * @param {string} jid  - Group JID
 */
async function getGroupMeta(sock, jid) {
    const { cache } = _getCache(sock);
    const entry = cache.get(jid);
    if (entry && (Date.now() - entry.ts) < TTL_MS) return entry.data;
    try {
        const meta = await sock.groupMetadata(jid);
        cache.set(jid, { data: meta, ts: Date.now() });
        _persist();
        return meta;
    } catch (err) {
        if (entry) return entry.data;
        throw err;
    }
}

/**
 * Get all groups the bot is in — returns cache if any fresh entries exist,
 * otherwise fetches all from WA and bulk-stores them.
 * @param {object} sock - Baileys socket
 * @param {boolean} forceRefresh - bypass cache
 */
async function getAllGroups(sock, forceRefresh = false) {
    const { cache, botId } = _getCache(sock);
    if (!forceRefresh && cache.size > 0) {
        const now = Date.now();
        const fresh = {};
        for (const [jid, entry] of cache.entries()) {
            if ((now - entry.ts) < TTL_MS) fresh[jid] = entry.data;
        }
        if (Object.keys(fresh).length > 0) return fresh;
    }
    try {
        const groups = await sock.groupFetchAllParticipating();
        const now = Date.now();
        _evict();
        for (const [jid, meta] of Object.entries(groups)) {
            cache.set(jid, { data: meta, ts: now });
        }
        _persist();
        logger.info(`[GroupCache] [${botId}] Fetched & cached ${Object.keys(groups).length} groups`);
        return groups;
    } catch (err) {
        logger.warn(`[GroupCache] [${botId}] groupFetchAllParticipating failed: ${err.message} — using stale cache`);
        const stale = {};
        for (const [jid, entry] of cache.entries()) stale[jid] = entry.data;
        return stale;
    }
}

/**
 * Warm up cache for a socket — called on connection.open
 * Staggered so it doesn't block the event loop on boot
 */
async function warmUp(sock) {
    const { cache, botId } = _getCache(sock);
    const now = Date.now();
    const state = _warmupState.get(botId) || { at: 0, running: false };
    if (state.running) return;
    if (now - Number(state.at || 0) < WARMUP_COOLDOWN_MS) return;
    state.running = true;
    _warmupState.set(botId, state);
    // Stagger warmup per session — each bot gets a different delay so they don't all
    // hammer groupFetchAllParticipating at the same time and trigger rate-overlimit
    const sessionIndex = _caches.size;
    const staggerMs = 10000 + (sessionIndex * 30000); // 10s, 40s, 70s, 100s, 130s
    setTimeout(async () => {
        try {
            if (sock?.ws?.readyState !== 1) return;
            // Skip if cache already has enough fresh data from disk.
            const checkNow = Date.now();
            const freshCount = [...cache.entries()].filter(([, e]) => (checkNow - e.ts) < TTL_MS).length;
            if (freshCount > 50) {
                logger.info(`[GroupCache] [${botId}] Skipping warm-up — ${freshCount} fresh entries already cached`);
                return;
            }
            const groups = await sock.groupFetchAllParticipating();
            let added = 0;
            for (const [jid, meta] of Object.entries(groups)) {
                if (!cache.has(jid) || (checkNow - cache.get(jid).ts) > TTL_MS) {
                    cache.set(jid, { data: meta, ts: checkNow });
                    added++;
                }
            }
            if (added > 0) {
                _persist();
                logger.info(`[GroupCache] [${botId}] Warmed ${added} new groups (total: ${cache.size})`);
            }
        } catch (e) {
            logger.warn(`[GroupCache] [${botId}] Warm-up failed: ${e.message}`);
        } finally {
            const done = _warmupState.get(botId) || { at: 0, running: false };
            done.at = Date.now();
            done.running = false;
            _warmupState.set(botId, done);
        }
    }, staggerMs);
}

/**
 * Invalidate a single group (e.g. after participant change)
 */
function invalidate(jid, sock) {
    if (sock) { const { cache } = _getCache(sock); cache.delete(jid); return; }
    for (const cache of _caches.values()) cache.delete(jid);
}

function set(jid, meta, sock) {
    if (sock) { const { cache } = _getCache(sock); cache.set(jid, { data: meta, ts: Date.now() }); }
    _persist();
}

function _normId(jid) {
    return String(jid || '').trim().replace(/:\d+(?=@)/g, '');
}

/**
 * Find a participant entry in already-fetched group metadata, matching against
 * ANY of the given candidate JIDs.
 *
 * Why this is needed: WhatsApp now frequently reports a sender as a LID
 * (e.g. "123456789012345@lid") in msg.key.participant while the group's
 * participants list (or vice versa) uses the phone-number JID
 * ("234801234567@s.whatsapp.net") — or the other way around. A strict
 * single-JID `===` or digit-only comparison silently fails in that case,
 * which is what was causing "admin"/"owner" to be misdetected. Callers
 * should pass every JID form they have available for the sender
 * (sender, msg.key.participant, msg.key.participantPn, sock.user?.lid, etc.)
 * so we have the best chance of matching whichever form the participants
 * list actually uses.
 */
function findParticipant(meta, candidateJids) {
    const candidates = (Array.isArray(candidateJids) ? candidateJids : [candidateJids])
        .filter(Boolean)
        .map(_normId);
    if (!candidates.length || !meta?.participants?.length) return null;
    const candidateSet = new Set(candidates);
    return meta.participants.find((p) => candidateSet.has(_normId(p?.id))) || null;
}

function isAdminInMeta(meta, candidateJids) {
    return !!(findParticipant(meta, candidateJids)?.admin);
}

function isAdmin(jid, senderJid, sock, extraCandidates) {
    if (!sock) return false;
    const { cache } = _getCache(sock);
    const entry = cache.get(jid);
    if (!entry || (Date.now() - entry.ts) >= TTL_MS) return false;
    const candidates = [senderJid, ...(Array.isArray(extraCandidates) ? extraCandidates : [extraCandidates])];
    return isAdminInMeta(entry.data, candidates);
}

/**
 * Async admin check with fallback: tries cache first, then refreshes if stale.
 * @param {string} jid - Group JID
 * @param {string} senderJid - Sender JID
 * @param {object} sock - Baileys socket
 * @param {number} timeoutMs - Max wait time (default 2000ms)
 * @param {string[]} [extraCandidates] - Alternate JID forms (LID/PN) for the same sender
 * @returns {Promise<boolean>}
 */
async function isAdminWithFallback(jid, senderJid, sock, timeoutMs = 2000, extraCandidates) {
    if (!sock) return false;

    // Fast path: try cache first
    const cached = isAdmin(jid, senderJid, sock, extraCandidates);
    if (cached) return true;

    // Slow path: refresh metadata if cache miss/stale
    try {
        await Promise.race([
            getGroupMeta(sock, jid),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
        ]);
        // After refresh, check again
        return isAdmin(jid, senderJid, sock, extraCandidates);
    } catch (err) {
        // Timeout or error: fallback to cached result even if stale
        const { cache } = _getCache(sock);
        const entry = cache.get(jid);
        if (!entry) return false;
        return isAdminInMeta(entry.data, [senderJid, ...(Array.isArray(extraCandidates) ? extraCandidates : [extraCandidates])]);
    }
}

function stats() {
    const result = {};
    for (const [botId, cache] of _caches.entries()) result[botId] = cache.size;
    return result;
}

// Load on module init without blocking startup
_loadPromise = _load();

// Periodic eviction every 30 min
setInterval(_evict, 30 * 60 * 1000).unref();

module.exports = { getGroupMeta, getAllGroups, warmUp, invalidate, set, isAdmin, isAdminWithFallback, isAdminInMeta, findParticipant, stats,
    // Clear all cached entries for a specific botId (called on node purge)
    clearForBot(botId) {
        const digits = String(botId || '').replace(/[^0-9]/g, '');
        if (!digits) return;
        _caches.delete(digits);
    },
};
