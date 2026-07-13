'use strict';
// core/anti/antiConfig.js
// ─── ANTI-SYSTEM CONFIG CACHE ─────────────────────────────────────────────────
//
// Provides an in-memory Map<groupJid, AntiConfig> so the anti engine never
// touches disk on the message-processing hot path.
//
// Schema for AntiConfig:
//   {
//     antiLink:         boolean,
//     antiBadword:      boolean,
//     antiSpam:         boolean,
//     antiSticker:      boolean,
//     antiAudio:        boolean,
//     antiVideo:        boolean,
//     antiImage:        boolean,
//     antiGif:          boolean,
//     antiDocument:     boolean,
//     antiLocation:     boolean,
//     antiContact:      boolean,
//     antiPoll:         boolean,
//     antiForeignMedia: boolean,
//     antiViewOnce:     boolean,
//     antiMentionAll:   boolean,
//     antiLargeGroup:   boolean,
//     antiFlood:        boolean,
//     antiBot:          boolean,
//     antiIos:          boolean,
//     antiAndroid:      boolean,
//     antiLeave:        boolean,
//     antiJoin:         boolean,
//     antiDelete:       boolean,
//     antiFakeid:       boolean,
//     antiRevoke:       boolean,
//     antiBlasphemy:    boolean,
//     antiPromote:      boolean,
//     antiSuspicious:   boolean,
//     antiScreen:       boolean,
//     antiForward:      boolean,
//     antiCBroadcast:   boolean,  // anti-channel-broadcast
//     antiGStatus:      boolean,  // blocks group-status broadcast jobs
//     allowedDomains:   string[], // link allowlist
//     badwords:         string[],
//     floodLimit:       number,   // msgs per 30s before kick
//     floodLimitMs:     number,   // rolling window ms
//     updatedAt:        number,
//   }

const fs   = require('fs');
const path = require('path');
const logger = require('../logger');

const DATA_DIR   = path.join(__dirname, '../../data');
const ANTI_FILE  = path.join(DATA_DIR, 'anti-config.json');

// ─── Bridge to plugins/pappy-admin.js's per-node group settings ──────────────
// pappy-admin.js is the source of truth for the 6 flags users actually toggle
// (.antilink/.antibot/.antispam/.antichannel/.antidemote/.antigstatus). It writes
// them to data/group_settings-{nodeDigits}.json keyed by "{nodeDigits}:{groupJid}".
// Without this bridge, antiEngine's 31-check pipeline (wired via antiHook.js) never
// sees those flags — it only ever reads anti-config.json, which nothing populates
// for them — so the extended checks (domain allowlists, badwords, media-type blocks,
// flood, etc.) stay permanently dark even when an admin enables anti-link/anti-spam/etc.
// This reads pappy-admin's file directly (short-lived in-memory cache; pappy-admin
// remains the sole writer) and translates its flag names into the antiEngine schema.
const ADMIN_FLAG_MAP = {
    antilink:     'antiLink',
    antibot:      'antiBot',
    antispam:     'antiSpam',
    antichannel:  'antiCBroadcast',
    antidemote:   'antiPromote',
    antigstatus:  'antiGStatus',
};

const ADMIN_SETTINGS_TTL_MS = 5000;
const _adminSettingsCache = new Map(); // botId(digits|'global') → { data, loadedAt }

function _adminSettingsPath(botId) {
    const digits = String(botId || '').replace(/[^0-9]/g, '');
    return digits
        ? path.join(DATA_DIR, `group_settings-${digits}.json`)
        : path.join(DATA_DIR, 'group_settings.json');
}

function _readAdminSettingsFile(botId) {
    const key = String(botId || '').replace(/[^0-9]/g, '') || 'global';
    const cached = _adminSettingsCache.get(key);
    const now = Date.now();
    if (cached && (now - cached.loadedAt) < ADMIN_SETTINGS_TTL_MS) return cached.data;

    let data = {};
    try {
        const file = _adminSettingsPath(botId);
        if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    } catch (e) {
        logger.warn(`[AntiConfig] failed to read admin group settings for ${key}: ${e.message}`);
    }
    _adminSettingsCache.set(key, { data, loadedAt: now });
    return data;
}

/**
 * _getAdminBridgedFlags — look up pappy-admin's flags for a group on a specific
 * node and translate them into antiEngine's flag names. Returns {} if the node's
 * settings file has no entry for this group (or no botId was supplied).
 */
function _getAdminBridgedFlags(groupJid, botId) {
    if (!botId) return {};
    const digits = String(botId).replace(/[^0-9]/g, '') || 'global';
    const all = _readAdminSettingsFile(botId);
    const scopeKey = `${digits}:${groupJid}`;
    const group = all[scopeKey];
    if (!group || typeof group !== 'object') return {};

    const bridged = {};
    for (const [adminKey, engineKey] of Object.entries(ADMIN_FLAG_MAP)) {
        if (group[adminKey] === true) bridged[engineKey] = true;
        else if (group[adminKey] === false) bridged[engineKey] = false;
    }
    return bridged;
}

// ─── Default config for a group with no saved settings ───────────────────────
const DEFAULT_ANTI_CONFIG = Object.freeze({
    antiLink:         false,
    antiForeignNumber:false,
    antiFakeNumber:   false,
    antiMentionSpam:  false,
    antiEmoji:        false,
    antiCaps:         false,
    antiInviteLink:   false,
    antiBadword:      false,
    antiSpam:         false,
    antiMedia:        false,
    antiSticker:      false,
    antiAudio:        false,
    antiVoice:        false,
    antiVideo:        false,
    antiImage:        false,
    antiGif:          false,
    antiDocument:     false,
    antiLocation:     false,
    antiContact:      false,
    antiPoll:         false,
    antiForeignMedia: false,
    antiViewOnce:     false,
    antiMentionAll:   false,
    antiLargeGroup:   false,
    antiFlood:        false,
    antiBot:          false,
    antiIos:          false,
    antiAndroid:      false,
    antiLeave:        false,
    antiJoin:         false,
    antiDelete:       false,
    antiFakeid:       false,
    antiRevoke:       false,
    antiBlasphemy:    false,
    antiPromote:      false,
    antiSuspicious:   false,
    antiScreen:       false,
    antiForward:      false,
    antiCBroadcast:   false,
    antiGStatus:      false,
    allowedDomains:   [],
    allowedPrefixes:  [],
    mentionThreshold: 5,
    capsThreshold:    0.75,
    emojiThreshold:   8,
    badwords:         [],
    floodLimit:       10,
    floodLimitMs:     30000,
    updatedAt:        0,
});

// ─── In-memory cache ──────────────────────────────────────────────────────────
const cache = new Map(); // groupJid → AntiConfig
const enabledGroups = new Set();
let _loaded = false;
let _flushTimer = null;
let _pendingFlush = {};

// ─── Serialization guard (mutex-like) ────────────────────────────────────────
let _flushInProgress = false;
const _flushQueue = [];


function _hasEnabledFlag(cfg) {
    if (!cfg) return false;
    for (const [k, v] of Object.entries(cfg)) {
        if (k.startsWith('anti') && v === true) return true;
    }
    return false;
}

function _indexEnabled(jid, cfg) {
    if (_hasEnabledFlag(cfg)) enabledGroups.add(jid);
    else enabledGroups.delete(jid);
}

// ─── Load all from disk on startup ───────────────────────────────────────────
function _load() {
    if (_loaded) return;
    _loaded = true;
    try {
        if (!fs.existsSync(ANTI_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(ANTI_FILE, 'utf8') || '{}');
        for (const [jid, cfg] of Object.entries(raw)) {
            const merged = { ...DEFAULT_ANTI_CONFIG, ...cfg };
            cache.set(String(jid), merged);
            _indexEnabled(String(jid), merged);
        }
        logger.info(`[AntiConfig] loaded ${cache.size} group config(s)`);
    } catch (e) {
        logger.warn(`[AntiConfig] load error: ${e.message}`);
    }
}

// ─── Atomic flush ─────────────────────────────────────────────────────────────
async function _flush() {
    if (_flushInProgress) {
        return new Promise((resolve) => _flushQueue.push(resolve));
    }
    _flushInProgress = true;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const payload = {};
        for (const [jid, cfg] of cache.entries()) payload[jid] = cfg;
        const tmp = `${ANTI_FILE}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2));
        await fs.promises.rename(tmp, ANTI_FILE);
    } catch (e) {
        logger.warn(`[AntiConfig] flush error: ${e.message}`);
    } finally {
        _flushInProgress = false;
        if (_flushQueue.length > 0) {
            const next = _flushQueue.shift();
            _flush().then(next).catch(next);
        }
    }
}

function _scheduleSave() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => {
        _flushTimer = null;
        _flush().catch(() => {});
    }, 600);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * getAntiConfig — returns a config object for a group, merging pappy-admin's
 * bridged flags (live, per-node, re-read every ADMIN_SETTINGS_TTL_MS) on top of
 * the native anti-config.json cache. Native fields (badwords, allowedDomains,
 * thresholds, and the extended checks pappy-admin has no UI for) pass through
 * untouched; the 6 flags pappy-admin owns always reflect its file, not stale
 * antiConfig state, so toggling `.antilink` etc. takes effect without a bind gap.
 * botId is required to resolve the correct per-node group_settings file — pass
 * it whenever it's available so the bridge is accurate.
 */
function getAntiConfig(groupJid, botId) {
    _load();
    const jid = String(groupJid || '').trim();
    if (!jid) return { ...DEFAULT_ANTI_CONFIG };
    if (!cache.has(jid)) {
        cache.set(jid, { ...DEFAULT_ANTI_CONFIG, updatedAt: Date.now() });
        enabledGroups.delete(jid);
    }
    const base = cache.get(jid);
    const bridged = _getAdminBridgedFlags(jid, botId);
    return Object.keys(bridged).length ? { ...base, ...bridged } : base;
}

/**
 * hasAntiConfig — check if any anti setting is enabled for a group, including
 * flags bridged live from pappy-admin's per-node settings file.
 */
function hasAnyAntiEnabled(groupJid, botId) {
    _load();
    const jid = String(groupJid || '');
    if (enabledGroups.has(jid)) return true;
    const bridged = _getAdminBridgedFlags(jid, botId);
    return Object.values(bridged).some((v) => v === true);
}

/**
 * setAntiFlag — set a single anti flag for a group, flush to disk.
 */
function setAntiFlag(groupJid, flag, value) {
    _load();
    const jid = String(groupJid || '').trim();
    if (!jid) return false;
    const cfg = getAntiConfig(jid);
    cfg[flag] = Boolean(value);
    cfg.updatedAt = Date.now();
    _indexEnabled(jid, cfg);
    _scheduleSave();
    return true;
}

/**
 * setAntiConfig — bulk update config for a group, flush to disk.
 */
function setAntiConfig(groupJid, updates = {}) {
    _load();
    const jid = String(groupJid || '').trim();
    if (!jid) return false;
    const cfg = getAntiConfig(jid);
    Object.assign(cfg, updates, { updatedAt: Date.now() });
    cache.set(jid, cfg);
    _indexEnabled(jid, cfg);
    _scheduleSave();
    return true;
}

/**
 * resetAntiConfig — clear all anti settings for a group.
 */
function resetAntiConfig(groupJid) {
    const jid = String(groupJid || '').trim();
    if (!jid) return false;
    cache.set(jid, { ...DEFAULT_ANTI_CONFIG, updatedAt: Date.now() });
    enabledGroups.delete(jid);
    _scheduleSave();
    return true;
}

/**
 * deleteGroupConfig — remove a group's config (e.g., after bot leaves).
 */
function deleteGroupConfig(groupJid) {
    const jid = String(groupJid || '').trim();
    if (!jid || !cache.has(jid)) return false;
    cache.delete(jid);
    enabledGroups.delete(jid);
    _scheduleSave();
    return true;
}

/**
 * getAllGroupJids — list all groups with stored config.
 */
function getAllGroupJids() {
    _load();
    return Array.from(cache.keys());
}

/**
 * init — call at bot startup to warm the cache.
 */
function init() {
    _load();
    logger.info(`[AntiConfig] ready — ${cache.size} group(s) cached`);
}

module.exports = {
    DEFAULT_ANTI_CONFIG,
    init,
    getAntiConfig,
    hasAnyAntiEnabled,
    setAntiFlag,
    setAntiConfig,
    resetAntiConfig,
    deleteGroupConfig,
    getAllGroupJids,
};
