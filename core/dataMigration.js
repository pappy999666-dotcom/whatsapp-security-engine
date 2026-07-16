'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const store = require('./userDataStore');

const VERSION = 1;
const MARKER = path.join(store.GLOBAL_ROOT, `migration-v${VERSION}.json`);
const BACKUP_ROOT = path.join(store.GLOBAL_ROOT, 'migration-backups');
const LEGACY_MAP = [
  { re: /^sudo-users-([0-9]+)\.json$/, namespace: 'sudo' },
  { re: /^(?:config|settings)-([0-9]+)\.json$/, namespace: 'config' },
  { re: /^(?:group-protection|protection)-([0-9]+)\.json$/, namespace: 'protection' },
  { re: /^ai-(?:config|context)-([0-9]+)\.json$/, namespace: 'ai' },
];
const readJson = async (file, fallback = null) => { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; } };
function mergeMissing(target, source) { if (Array.isArray(target) || Array.isArray(source)) return target?.length ? target : source; if (!target || typeof target !== 'object' || !source || typeof source !== 'object') return target ?? source; const out = { ...target }; for (const [key, value] of Object.entries(source)) out[key] = key in out ? mergeMissing(out[key], value) : value; return out; }
async function backup(file) { const body = await fsp.readFile(file); const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12); const dest = path.join(BACKUP_ROOT, `${path.basename(file)}.${hash}.bak`); await fsp.mkdir(BACKUP_ROOT, { recursive: true }); try { await fsp.access(dest); } catch { await fsp.writeFile(dest, body, { mode: 0o600 }); } return dest; }
async function migrateLegacyData(pairingRegistry, logger = console) {
  await store.init();
  const previous = await readJson(MARKER);
  if (previous?.completed) return previous;
  const report = { version: VERSION, startedAt: new Date().toISOString(), imported: [], ambiguous: [], skipped: [], backups: [] };
  const registry = pairingRegistry.entries();
  for (const [tgUserId] of registry) await store.ensureUser(tgUserId);
  const entries = await fsp.readdir(store.DATA_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rule = LEGACY_MAP.map((item) => ({ item, match: entry.name.match(item.re) })).find((x) => x.match);
    if (!rule) continue;
    const phone = rule.match[1];
    const owners = registry.filter(([, node]) => String(node.phone || node).replace(/[^0-9]/g, '') === phone);
    if (owners.length !== 1) { report.ambiguous.push({ file: entry.name, reason: owners.length ? 'multiple-owners' : 'owner-not-found' }); continue; }
    const file = path.join(store.DATA_ROOT, entry.name);
    const legacy = await readJson(file);
    if (legacy == null) { report.skipped.push({ file: entry.name, reason: 'invalid-json' }); continue; }
    report.backups.push(await backup(file));
    const [tgUserId] = owners[0];
    const current = await store.get(tgUserId, rule.item.namespace);
    await store.set(tgUserId, rule.item.namespace, mergeMissing(current, legacy));
    report.imported.push({ file: entry.name, tgUserId, namespace: rule.item.namespace });
  }
  const economyFile = path.join(store.DATA_ROOT, 'tg-game-economy.json');
  const economy = await readJson(economyFile);
  if (economy?.users) {
    report.backups.push(await backup(economyFile));
    for (const [tgUserId, profile] of Object.entries(economy.users)) { await store.ensureUser(tgUserId); await store.set(tgUserId, 'economy', { users: { [tgUserId]: profile } }); report.imported.push({ file: 'tg-game-economy.json', tgUserId, namespace: 'economy' }); }
  }
  report.completed = true; report.completedAt = new Date().toISOString();
  await store.atomicWrite(MARKER, report);
  logger.info?.(`[Migration] v${VERSION}: ${report.imported.length} imported, ${report.ambiguous.length} unresolved`);
  return report;
}
module.exports = { VERSION, MARKER, migrateLegacyData, mergeMissing };
