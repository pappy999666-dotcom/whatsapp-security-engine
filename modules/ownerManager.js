'use strict';
// modules/ownerManager.js — Dynamic owner & sudo JID registry

const fsp  = require('fs').promises;
const path = require('path');
const logger = require('../core/logger');

const DB_PATH = path.join(__dirname, '../data/owner.json');

let _db = { ownerJids: [], sudoJids: [] };
let _writePending = false;

async function load() {
    try {
        const raw = await fsp.readFile(DB_PATH, 'utf8');
        _db = JSON.parse(raw);
    } catch {
        _db = { ownerJids: [], sudoJids: [] };
    }
}

async function save() {
    if (_writePending) return;
    _writePending = true;
    try {
        await fsp.writeFile(DB_PATH, JSON.stringify(_db, null, 2), 'utf8');
    } catch (err) {
        logger.error('[OwnerManager] Save failed', { error: err.message });
    } finally {
        _writePending = false;
    }
}

// Normalize JID — ensure it ends with @s.whatsapp.net
function normalizeJid(jid) {
    if (!jid) return null;
    const clean = jid.replace(/[^0-9]/g, '');
    return `${clean}@s.whatsapp.net`;
}

// Match by digits only — works for @lid, @s.whatsapp.net, @c.us etc
function _matchesAny(jid, list) {
    if (!jid) return false;
    const digits = jid.replace(/[^0-9]/g, '');
    return list.some(j => j === jid || j.replace(/[^0-9]/g, '') === digits);
}

function isOwner(jid) {
    try { return require('./permissionEngine').isGlobalOwner(jid); }
    catch { return _matchesAny(jid, _db.ownerJids); }
}

// Legacy global sudo is kept only for old informational commands. Runtime auth must use per-node sudo.
function isSudo(jid)  { return _matchesAny(jid, _db.sudoJids); }

function isAuthorized(jid) {
    return isOwner(jid) || isSudo(jid);
}

async function addOwner(jid) {
    const normalized = normalizeJid(jid) || jid;
    if (!_db.ownerJids.includes(normalized)) {
        _db.ownerJids.push(normalized);
        await save();
        logger.success(`[OwnerManager] Added owner: ${normalized}`);
    }
}

async function addSudo(jid) {
    const normalized = normalizeJid(jid) || jid;
    if (!_db.sudoJids.includes(normalized)) {
        _db.sudoJids.push(normalized);
        await save();
        logger.success(`[OwnerManager] Added sudo: ${normalized}`);
    }
}

async function removeSudo(jid) {
    const normalized = normalizeJid(jid) || jid;
    _db.sudoJids = _db.sudoJids.filter(j => j !== normalized && j !== jid);
    await save();
    logger.info(`[OwnerManager] Removed sudo: ${normalized}`);
}

async function removeOwner(jid) {
    const normalized = normalizeJid(jid) || jid;
    _db.ownerJids = _db.ownerJids.filter(j => j !== normalized && j !== jid);
    await save();
    logger.info(`[OwnerManager] Removed owner: ${normalized}`);
}

function getOwners() { return [..._db.ownerJids]; }
function getSudos()  { return [..._db.sudoJids]; }

// Auto-register a newly paired number — store in pairing registry only, NOT as global owner
// Each node owner only has owner access on their own bot via session-scoped checks
async function registerPairedNumber(phoneNumber) {
    const jid = `${phoneNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    // Do NOT add to ownerJids — that would give cross-node owner access
    return jid;
}

// ─── Per-node sudo management ─────────────────────────────────────────────────
// Node-scoped sudo is tracked by permissionEngine.js using nodeSudos map.
// These helpers delegate to permissionEngine if available, else fallback to
// the global sudoJids list (legacy compat).

async function addSudoForNode(botId, jid) {
    try {
        const pe = require('./permissionEngine');
        pe.addNodeSudo(String(botId), jid);
    } catch { await addSudo(jid); }
}

async function removeSudoForNode(botId, jid) {
    try {
        const pe = require('./permissionEngine');
        pe.removeNodeSudo(String(botId), jid);
    } catch { await removeSudo(jid); }
}

function isSudoOnNode(jid, botId) {
    try {
        const pe = require('./permissionEngine');
        return pe.isNodeSudo(jid, String(botId));
    } catch { return isSudo(jid); }
}

// Load on module init
load().catch(() => {});

module.exports = {
    load, isOwner, isSudo, isAuthorized, addOwner, addSudo, removeSudo, removeOwner,
    getOwners, getSudos, registerPairedNumber, normalizeJid,
    addSudoForNode, removeSudoForNode, isSudoOnNode,
};
