'use strict';

const fsp = require('fs').promises;
const path = require('path');
const userDataStore = require('../core/userDataStore');
const DB_PATH = path.join(__dirname, '../data/pairing_registry.json');
let registry = {};
let saveChain = Promise.resolve();
const normalizePhone = (value) => String(value || '').replace(/[^0-9]/g, '');
function normalizeRecord(tgUserId, value) { if (value && typeof value === 'object') return { phone: normalizePhone(value.phone), slotId: String(value.slotId || '1'), sessionKey: value.sessionKey || `${tgUserId}_${normalizePhone(value.phone)}_${value.slotId || '1'}`, createdAt: value.createdAt || null, updatedAt: value.updatedAt || null }; const phone = normalizePhone(value); return { phone, slotId: '1', sessionKey: `${tgUserId}_${phone}_1`, createdAt: null, updatedAt: null }; }
async function load() { try { registry = JSON.parse(await fsp.readFile(DB_PATH, 'utf8')); } catch { registry = {}; } return registry; }
async function save() { const snapshot = JSON.stringify(registry, null, 2); saveChain = saveChain.then(async () => { await fsp.mkdir(path.dirname(DB_PATH), { recursive: true }); const tmp = `${DB_PATH}.${process.pid}.tmp`; await fsp.writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 }); await fsp.rename(tmp, DB_PATH); }); return saveChain; }
function getRecord(tgUserId) { const value = registry[String(tgUserId)]; return value == null ? null : normalizeRecord(String(tgUserId), value); }
const getPhone = (tgUserId) => getRecord(tgUserId)?.phone || null;
const hasBot = (tgUserId) => Boolean(getRecord(tgUserId)?.phone);
const entries = () => Object.entries(registry).map(([id, value]) => [id, normalizeRecord(id, value)]);
function getUserIdByPhone(phoneNumber) { const target = normalizePhone(phoneNumber); if (!target) return null; const matches = entries().filter(([, node]) => node.phone === target); return matches.length === 1 ? matches[0][0] : null; }
function getUserIdBySession(sessionKey) { const matches = entries().filter(([, node]) => node.sessionKey === String(sessionKey || '')); return matches.length === 1 ? matches[0][0] : null; }
const ownsSession = (tgUserId, sessionKey) => getRecord(tgUserId)?.sessionKey === String(sessionKey || '');
async function register(tgUserId, phoneNumber, slotId = '1', sessionKey = null) { const id = String(tgUserId); const now = new Date().toISOString(); const previous = getRecord(id); const phone = normalizePhone(phoneNumber); registry[id] = { phone, slotId: String(slotId), sessionKey: sessionKey || `${id}_${phone}_${slotId}`, createdAt: previous?.createdAt || now, updatedAt: now }; await userDataStore.ensureUser(id); await save(); return getRecord(id); }
async function unregister(tgUserId) { delete registry[String(tgUserId)]; await save(); }
async function unregisterByPhone(phoneNumber) { const tgUserId = getUserIdByPhone(phoneNumber); if (tgUserId) await unregister(tgUserId); }
load().catch(() => {});
module.exports = { getRecord, getPhone, hasBot, entries, getUserIdByPhone, getUserIdBySession, ownsSession, register, unregister, unregisterByPhone, load };
