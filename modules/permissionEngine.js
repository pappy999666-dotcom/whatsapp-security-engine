'use strict';
// modules/permissionEngine.js
// ─── CANONICAL PERMISSION ENGINE ─────────────────────────────────────────────
//
// Single source of truth for ALL role resolution in Pappy V2.
// Replaces fragmented checks scattered across telegram.js, commandRouter.js,
// whatsapp.js, and the old permission.js.
//
// HOT-PATH CONTRACT: resolveRole() and can() NEVER touch disk.
// Sudo/Owner sets are loaded once at startup and hot-reloaded via fs.watch.

const fs   = require('fs');
const path = require('path');
const logger = require('../core/logger');

const DATA_DIR        = path.join(__dirname, '../data');
const OWNER_FILE      = path.join(DATA_DIR, 'owner.json');
const SUDO_FILE       = path.join(DATA_DIR, 'sudo.json'); // legacy aggregate file
const PER_NODE_SUDO_RE = /^sudo-users-(.+)\.json$/;

// ─── Role constants ───────────────────────────────────────────────────────────
const ROLES = Object.freeze({
    GLOBAL_OWNER: 'global_owner',  // owns the entire bot deployment
    NODE_OWNER:   'node_owner',    // owns a specific WA session/node
    NODE_SUDO:    'node_sudo',     // sudo on a specific node
    GROUP_ADMIN:  'group_admin',   // WA group admin (no bot privilege)
    PUBLIC:       'public',        // anyone else
});

const ROLE_LEVEL = {
    [ROLES.GLOBAL_OWNER]: 4,
    [ROLES.NODE_OWNER]:   3,
    [ROLES.NODE_SUDO]:    2,
    [ROLES.GROUP_ADMIN]:  1,
    [ROLES.PUBLIC]:       0,
};

// ─── In-memory caches (Sets for O(1) lookup) ─────────────────────────────────
// globalOwners:  Set<jid>          — from owner.json + env OWNER_WA_JID
// nodeOwners:    Map<botId, Set<jid>>
// nodeSudos:     Map<botId, Set<jid>>
let globalOwners = new Set();
let nodeOwners   = new Map();
let nodeSudos    = new Map();
let _loaded      = false;
let _watchersSet = false;

// ─── Loader ───────────────────────────────────────────────────────────────────
function _readJsonFile(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8') || JSON.stringify(fallback));
    } catch (e) {
        logger.warn(`[PermissionEngine] ignored ${path.basename(file)}: ${e.message}`);
        return fallback;
    }
}

function _mergeNodeSudoList(botId, rawList) {
    const bid = normalizeBotId(botId);
    const list = Array.isArray(rawList) ? rawList : (rawList?.sudoJids || rawList?.sudos || []);
    if (!bid || !Array.isArray(list)) return;
    if (!nodeSudos.has(bid)) nodeSudos.set(bid, new Set());
    for (const jid of list.map(normalizeJid).filter(Boolean)) nodeSudos.get(bid).add(jid);
}

function _loadPerNodeSudoFiles() {
    if (!fs.existsSync(DATA_DIR)) return;
    for (const file of fs.readdirSync(DATA_DIR)) {
        const match = PER_NODE_SUDO_RE.exec(file);
        if (!match) continue;
        const raw = _readJsonFile(path.join(DATA_DIR, file), []);
        _mergeNodeSudoList(match[1], raw);
    }
}

function _loadFromDisk() {
    try {
        const ownerRaw = fs.existsSync(OWNER_FILE)
            ? JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8') || '{}')
            : {};
        const sudoRaw = _readJsonFile(SUDO_FILE, {});

        // globalOwners: support legacy and current schemas.
        // Current ownerManager writes { ownerJids: [], sudoJids: [] }; node sudos are NOT global.
        const gOwners = Array.isArray(ownerRaw)
            ? ownerRaw
            : (ownerRaw.ownerJids || ownerRaw.global || ownerRaw.owners || []);
        globalOwners = new Set(gOwners.map(normalizeJid).filter(Boolean));

        // Seed from env
        const envJids = String(process.env.OWNER_WA_JID || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const j of envJids) {
            const normalized = normalizeJid(j);
            if (normalized) globalOwners.add(normalized);
        }

        // nodeOwners: { [botId]: [jid, ...] }
        nodeOwners = new Map();
        for (const [botId, jids] of Object.entries(ownerRaw.nodes || {})) {
            nodeOwners.set(normalizeBotId(botId), new Set(Array.isArray(jids) ? jids.map(normalizeJid).filter(Boolean) : []));
        }

        // nodeSudos: only node-keyed objects are valid. A top-level array would be
        // legacy global sudo and must NOT grant cross-node WhatsApp permissions.
        nodeSudos = new Map();
        if (sudoRaw && !Array.isArray(sudoRaw) && typeof sudoRaw === 'object') {
            for (const [botId, jids] of Object.entries(sudoRaw)) _mergeNodeSudoList(botId, jids);
        }

        // Preferred on-disk format for node sudo isolation: data/sudo-users-{PHONE}.json.
        _loadPerNodeSudoFiles();

        _loaded = true;
    } catch (err) {
        logger.warn(`[PermissionEngine] load error: ${err.message}`);
        _loaded = true;
    }
}

function normalizeJid(jid) {
    const raw = String(jid || '').trim();
    if (!raw) return '';
    if (raw.includes('@')) {
        const [left, server] = raw.split('@');
        const digits = left.replace(/[^0-9]/g, '');
        return digits ? `${digits}@${server || 's.whatsapp.net'}` : raw;
    }
    const digits = raw.replace(/[^0-9]/g, '');
    return digits ? `${digits}@s.whatsapp.net` : raw;
}

function normalizeBotId(botId) {
    const raw = String(botId || '').trim();
    const digits = raw.replace(/[^0-9]/g, '');
    return digits || raw;
}

function sameJid(a, b) {
    const na = normalizeJid(a);
    const nb = normalizeJid(b);
    return !!na && !!nb && na === nb;
}

function setHasJid(set, jid) {
    const normalized = normalizeJid(jid);
    if (!normalized || !set) return false;
    if (set.has(normalized)) return true;
    for (const item of set) if (sameJid(item, normalized)) return true;
    return false;
}

function _ensureLoaded() {
    if (!_loaded) _loadFromDisk();
}

// ─── fs.watch hot-reload ──────────────────────────────────────────────────────
function _startWatchers() {
    if (_watchersSet) return;
    _watchersSet = true;
    const reload = (label) => {
        logger.info(`[PermissionEngine] hot-reload triggered by ${label}`);
        _loaded = false;
        _loadFromDisk();
    };
    for (const [file, label] of [[OWNER_FILE, 'owner.json'], [SUDO_FILE, 'sudo.json']]) {
        try {
            const watcher = fs.watch(file, () => reload(label));
            if (typeof watcher.unref === 'function') watcher.unref();
        } catch {
            // file may not exist yet — that's fine
        }
    }
    try {
        const watcher = fs.watch(DATA_DIR, (_event, filename) => {
            if (filename && PER_NODE_SUDO_RE.test(String(filename))) reload(filename);
        });
        if (typeof watcher.unref === 'function') watcher.unref();
    } catch {
        // data dir may not exist yet — init/save creates it later
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * resolveRole — determine the highest role a JID holds in a given bot context.
 * groupAdminJids is optional — caller must supply if group-admin check matters.
 * NEVER reads disk.
 */
function resolveRole(senderJid, botId, groupAdminJids = null) {
    _ensureLoaded();
    const jid = normalizeJid(senderJid);
    if (!jid) return ROLES.PUBLIC;

    if (setHasJid(globalOwners, jid)) return ROLES.GLOBAL_OWNER;

    const bid = normalizeBotId(botId);
    if (bid && nodeOwners.has(bid) && setHasJid(nodeOwners.get(bid), jid)) return ROLES.NODE_OWNER;
    // A paired node's own WhatsApp JID is its node owner even when no owner.json node map exists.
    if (bid && sameJid(jid, bid)) return ROLES.NODE_OWNER;
    if (bid && nodeSudos.has(bid)  && setHasJid(nodeSudos.get(bid), jid))  return ROLES.NODE_SUDO;

    if (Array.isArray(groupAdminJids) && groupAdminJids.some((admin) => sameJid(admin, jid))) return ROLES.GROUP_ADMIN;

    return ROLES.PUBLIC;
}

/**
 * can — check whether senderJid meets the required role threshold.
 */
function can(senderJid, botId, requiredRole, groupAdminJids = null) {
    const actual   = resolveRole(senderJid, botId, groupAdminJids);
    const actual_n = ROLE_LEVEL[actual]   ?? 0;
    const req_n    = ROLE_LEVEL[requiredRole] ?? 0;
    return actual_n >= req_n;
}

/**
 * isGlobalOwner — quick check used by many callers.
 */
function isGlobalOwner(jid) {
    _ensureLoaded();
    return setHasJid(globalOwners, jid);
}

/**
 * isNodeOwner — check ownership of a specific bot node.
 */
function isNodeOwner(jid, botId) {
    _ensureLoaded();
    const bid = normalizeBotId(botId);
    if (!bid) return false;
    return (nodeOwners.has(bid) && setHasJid(nodeOwners.get(bid), jid)) || sameJid(jid, bid);
}

/**
 * isNodeSudo — check sudo privilege on a specific bot node.
 */
function isNodeSudo(jid, botId) {
    _ensureLoaded();
    const bid = normalizeBotId(botId);
    if (!bid) return false;
    return nodeSudos.has(bid) && setHasJid(nodeSudos.get(bid), jid);
}

/**
 * getGlobalOwners — returns a frozen Set of global owner JIDs.
 */
function getGlobalOwners() {
    _ensureLoaded();
    return globalOwners;
}

/**
 * addGlobalOwner — in-memory add + flush to disk.
 */
function addGlobalOwner(jid) {
    _ensureLoaded();
    const j = normalizeJid(jid);
    if (!j) return false;
    globalOwners.add(j);
    _flushOwners();
    return true;
}

/**
 * removeGlobalOwner — in-memory remove + flush to disk.
 */
function removeGlobalOwner(jid) {
    _ensureLoaded();
    const j = normalizeJid(jid);
    if (!j) return false;
    const removed = globalOwners.delete(j);
    if (removed) _flushOwners();
    return removed;
}

/**
 * addNodeSudo — grant sudo on a node.
 */
function addNodeSudo(botId, jid) {
    _ensureLoaded();
    const bid = normalizeBotId(botId);
    const j   = normalizeJid(jid);
    if (!bid || !j) return false;
    if (!nodeSudos.has(bid)) nodeSudos.set(bid, new Set());
    nodeSudos.get(bid).add(j);
    _flushSudos();
    return true;
}

/**
 * removeNodeSudo — revoke sudo on a node.
 */
function removeNodeSudo(botId, jid) {
    _ensureLoaded();
    const bid = normalizeBotId(botId);
    const j   = normalizeJid(jid);
    if (!bid || !j) return false;
    if (!nodeSudos.has(bid)) return false;
    const removed = nodeSudos.get(bid).delete(j);
    if (removed) _flushSudos();
    return removed;
}

/**
 * getNodeSudos — get all sudo JIDs for a node.
 */
function getNodeSudos(botId) {
    _ensureLoaded();
    const bid = normalizeBotId(botId);
    return bid && nodeSudos.has(bid) ? Array.from(nodeSudos.get(bid)) : [];
}

// ─── Disk flush helpers ───────────────────────────────────────────────────────
function _flushOwners() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const existing = fs.existsSync(OWNER_FILE)
            ? JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8') || '{}')
            : {};
        const payload = Array.isArray(existing)
            ? Array.from(globalOwners)
            : { ...existing, ownerJids: Array.from(globalOwners) };
        const tmp = `${OWNER_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, OWNER_FILE);
    } catch (e) {
        logger.warn(`[PermissionEngine] owner flush error: ${e.message}`);
    }
}

function _flushSudos() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const payload = {};
        for (const [bid, set] of nodeSudos.entries()) {
            const list = Array.from(set);
            payload[bid] = list;
            const perNode = path.join(DATA_DIR, `sudo-users-${bid}.json`);
            const tmpNode = `${perNode}.tmp`;
            fs.writeFileSync(tmpNode, JSON.stringify({ sudoJids: list }, null, 2));
            fs.renameSync(tmpNode, perNode);
        }
        const tmp = `${SUDO_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, SUDO_FILE);
    } catch (e) {
        logger.warn(`[PermissionEngine] sudo flush error: ${e.message}`);
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init() {
    _loadFromDisk();
    _startWatchers();
    logger.info(`[PermissionEngine] ready — ${globalOwners.size} global owner(s)`);
}

module.exports = {
    ROLES,
    ROLE_LEVEL,
    init,
    resolveRole,
    can,
    isGlobalOwner,
    isNodeOwner,
    isNodeSudo,
    getGlobalOwners,
    addGlobalOwner,
    removeGlobalOwner,
    normalizeJid,
    normalizeBotId,
    addNodeSudo,
    removeNodeSudo,
    getNodeSudos,
};
