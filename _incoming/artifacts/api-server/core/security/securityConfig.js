'use strict';
// core/security/securityConfig.js
// ─── FORTRESS SECURITY CONFIG STORE ────────────────────────────────────────────
//
// Additive only: this file never re-declares a flag that already exists in
// pappy-admin's data/group_settings-{botId}.json or antiConfig's schema (e.g.
// .antilink/.antibot/.antispam). It stores ONLY the genuinely new settings the
// Fortress pipeline introduces (deep-link/identity-antibot/smart-velocity
// toggles+actions, the global action-message toggle, and per-violation message
// templates). This keeps a single source of truth per concern instead of a
// second, disconnected config file — the exact bug Round 1 fixed for antiConfig.

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const DATA_DIR = path.join(__dirname, '../../data');
const FILE = path.join(DATA_DIR, 'security_config.json');

const DEFAULT_GROUP_CONFIG = Object.freeze({
    fortressLinkEnabled:  false,
    fortressLinkAction:   'delete_warn',   // 'delete' | 'warn' | 'kick' | 'delete_warn'
    fortressBotEnabled:   false,
    fortressBotAction:    'kick',
    fortressSpamEnabled:  false,
    fortressSpamSeconds:  5,               // 1-60s velocity window
    fortressSpamAction:   'kick',
    actionToggle:         true,            // false = log only, never send an action message
    messages: {
        link: '⚠️ $mention, links are not allowed here.\n📌 Reason: $rsn',
        bot:  '🤖 $mention was removed — identified as an automated client.\n📌 Reason: $rsn',
        spam: '⚡ $mention is sending messages too fast ($count in a row) — $rsn',
    },
    warns: {},
    updatedAt: 0,
});

const _cache = new Map(); // `${botId}:${groupJid}` → config
let _loaded = false;
let _flushTimer = null;

function _scopeKey(botId, groupJid) {
    const digits = String(botId || '').replace(/[^0-9]/g, '') || 'global';
    return `${digits}:${groupJid}`;
}

function _load() {
    if (_loaded) return;
    _loaded = true;
    try {
        if (!fs.existsSync(FILE)) return;
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}');
        for (const [key, cfg] of Object.entries(raw)) {
            _cache.set(key, { ...DEFAULT_GROUP_CONFIG, ...cfg, messages: { ...DEFAULT_GROUP_CONFIG.messages, ...(cfg.messages || {}) } });
        }
        logger.info(`[SecurityConfig] loaded ${_cache.size} group config(s)`);
    } catch (e) {
        logger.warn(`[SecurityConfig] load error: ${e.message}`);
    }
}

function _scheduleSave() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(async () => {
        _flushTimer = null;
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            const payload = {};
            for (const [key, cfg] of _cache.entries()) payload[key] = cfg;
            const tmp = `${FILE}.tmp`;
            await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2));
            await fs.promises.rename(tmp, FILE);
        } catch (e) {
            logger.warn(`[SecurityConfig] flush error: ${e.message}`);
        }
    }, 600);
}

function getConfig(groupJid, botId) {
    _load();
    const key = _scopeKey(botId, groupJid);
    if (!_cache.has(key)) {
        _cache.set(key, { ...DEFAULT_GROUP_CONFIG, messages: { ...DEFAULT_GROUP_CONFIG.messages }, warns: {}, updatedAt: Date.now() });
    }
    return _cache.get(key);
}

function setConfig(groupJid, botId, updates = {}) {
    _load();
    const key = _scopeKey(botId, groupJid);
    const cfg = getConfig(groupJid, botId);
    Object.assign(cfg, updates, { updatedAt: Date.now() });
    _cache.set(key, cfg);
    _scheduleSave();
    return cfg;
}

function setMessageTemplate(groupJid, botId, violationType, template) {
    const cfg = getConfig(groupJid, botId);
    cfg.messages = { ...cfg.messages, [violationType]: template };
    cfg.updatedAt = Date.now();
    _scheduleSave();
    return cfg;
}

function bumpWarn(groupJid, botId, userJid) {
    const cfg = getConfig(groupJid, botId);
    cfg.warns[userJid] = (cfg.warns[userJid] || 0) + 1;
    _scheduleSave();
    return cfg.warns[userJid];
}

function resetWarn(groupJid, botId, userJid) {
    const cfg = getConfig(groupJid, botId);
    cfg.warns[userJid] = 0;
    _scheduleSave();
}

function init() {
    _load();
    logger.info(`[SecurityConfig] ready — ${_cache.size} group(s) cached`);
}

module.exports = {
    DEFAULT_GROUP_CONFIG,
    init,
    getConfig,
    setConfig,
    setMessageTemplate,
    bumpWarn,
    resetWarn,
};
