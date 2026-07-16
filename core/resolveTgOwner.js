'use strict';

const pairingRegistry = require('../modules/pairingRegistry');
const userDataStore = require('./userDataStore');

function normalizePhone(value) { return String(value || '').replace(/[^0-9]/g, ''); }
function parseSessionKey(sessionKey) {
  const raw = String(sessionKey || '');
  const match = raw.match(/^([^_]+)_([0-9]+)(?:_([^_]+))?$/);
  return match ? { tgUserId: match[1], phone: match[2], slotId: match[3] || '1' } : null;
}
function resolveTgOwner(input = {}) {
  if (input.tgUserId != null) return String(input.tgUserId);
  const parsed = parseSessionKey(input.sessionKey || input.sessionFolder);
  if (parsed && pairingRegistry.ownsSession(parsed.tgUserId, input.sessionKey || input.sessionFolder)) return parsed.tgUserId;
  const phone = normalizePhone(input.phoneNumber || input.botId || input.sock?.user?.id);
  if (phone) return pairingRegistry.getUserIdByPhone(phone);
  return null;
}
function requireTgOwner(input) { const id = resolveTgOwner(input); if (!id) { const error = new Error('Telegram owner could not be resolved'); error.code = 'TG_OWNER_UNRESOLVED'; throw error; } return id; }
function resolveOwnerContext(input) { const tgUserId = requireTgOwner(input); return Object.freeze({ tgUserId, userStore: userDataStore.bind(tgUserId) }); }
module.exports = { normalizePhone, parseSessionKey, resolveTgOwner, requireTgOwner, resolveOwnerContext };
