'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DATA_ROOT = path.resolve(process.env.PAPPY_DATA_ROOT || path.join(__dirname, '../data'));
const USERS_ROOT = path.join(DATA_ROOT, 'users');
const GLOBAL_ROOT = path.join(DATA_ROOT, 'global');
const HOT_WRITE_DELAY_MS = 2000;
const DEFAULTS = Object.freeze({
  config: { botName: 'Pappy', prefix: '.', mode: 'public', autoRead: false, autoTyping: false, autoRecording: false },
  protection: { groups: {} }, economy: { users: {} }, sudo: { nodes: {} },
  ai: { provider: null, model: null, endpoint: null, apiKeyEncrypted: null, customPrompt: '', groups: {}, enabled: false },
  aiContexts: { chats: {} }, intel: { intake: [], active: [], used: [], invalid: [] },
  support: { tickets: [] }, metadata: { schemaVersion: 1, createdAt: null, updatedAt: null },
});
const FILES = Object.freeze({ config: 'config.json', protection: 'protection.json', economy: 'economy.json', sudo: 'sudo.json', ai: 'ai.json', aiContexts: 'ai-contexts.json', intel: 'intel.json', support: 'support.json', metadata: 'metadata.json' });
const cache = new Map();
const pendingWrites = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));
function safeId(value, label = 'identifier') { const id = String(value ?? '').trim(); if (!id || !/^[A-Za-z0-9_.@+-]+$/.test(id) || id.includes('..')) throw new TypeError(`Invalid ${label}`); return id; }
const userRoot = (id) => path.join(USERS_ROOT, safeId(id, 'Telegram user id'));
function fileFor(id, namespace) { if (!FILES[namespace]) throw new TypeError(`Unknown user namespace: ${namespace}`); return path.join(userRoot(id), FILES[namespace]); }
const cacheKey = (id, namespace) => `${safeId(id)}:${namespace}`;
async function atomicWrite(file, value) { await fsp.mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${Date.now()}.tmp`; await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); await fsp.rename(temp, file); }
async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') { try { await fsp.rename(file, `${file}.corrupt-${Date.now()}`); } catch {} } return clone(fallback); } }
async function ensureUser(id) { id = safeId(id, 'Telegram user id'); await fsp.mkdir(userRoot(id), { recursive: true, mode: 0o700 }); for (const namespace of Object.keys(FILES)) { const file = fileFor(id, namespace); try { await fsp.access(file); } catch { const value = clone(DEFAULTS[namespace]); if (namespace === 'metadata') value.createdAt = value.updatedAt = new Date().toISOString(); await atomicWrite(file, value); } } return bind(id); }
async function get(id, namespace) { const key = cacheKey(id, namespace); if (cache.has(key)) return clone(cache.get(key)); const value = await readJson(fileFor(id, namespace), DEFAULTS[namespace]); cache.set(key, value); return clone(value); }
async function set(id, namespace, value, options = {}) { const key = cacheKey(id, namespace); const snapshot = clone(value); cache.set(key, snapshot); const write = async () => { pendingWrites.delete(key); await atomicWrite(fileFor(id, namespace), snapshot); }; if (options.debounce === true || namespace === 'economy' || namespace === 'aiContexts') { clearTimeout(pendingWrites.get(key)); const timer = setTimeout(() => write().catch(() => {}), HOT_WRITE_DELAY_MS); timer.unref?.(); pendingWrites.set(key, timer); } else await write(); return clone(snapshot); }
async function update(id, namespace, updater, options) { const current = await get(id, namespace); const next = await updater(current); return set(id, namespace, next === undefined ? current : next, options); }
async function flush(id = null) { const prefix = id == null ? '' : `${safeId(id)}:`; const tasks = []; for (const [key, timer] of pendingWrites) { if (!key.startsWith(prefix)) continue; clearTimeout(timer); pendingWrites.delete(key); const split = key.indexOf(':'); const owner = key.slice(0, split); const namespace = key.slice(split + 1); tasks.push(atomicWrite(fileFor(owner, namespace), cache.get(key))); } await Promise.all(tasks); }
async function purgeUser(id) { id = safeId(id, 'Telegram user id'); await flush(id); for (const key of cache.keys()) if (key.startsWith(`${id}:`)) cache.delete(key); await fsp.rm(userRoot(id), { recursive: true, force: true }); }
function bind(id) { id = safeId(id, 'Telegram user id'); return Object.freeze({ tgUserId: id, root: userRoot(id), get: (ns) => get(id, ns), set: (ns, value, options) => set(id, ns, value, options), update: (ns, fn, options) => update(id, ns, fn, options), flush: () => flush(id), purge: () => purgeUser(id) }); }
async function init() { await Promise.all([fsp.mkdir(USERS_ROOT, { recursive: true }), fsp.mkdir(GLOBAL_ROOT, { recursive: true })]); }
module.exports = { DATA_ROOT, USERS_ROOT, GLOBAL_ROOT, DEFAULTS, FILES, init, ensureUser, get, set, update, flush, purgeUser, bind, safeId, atomicWrite };
