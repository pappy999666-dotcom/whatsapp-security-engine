'use strict';
// core/security/deviceIdentity.js
// ─── DEEP ANTIBOT — IDENTITY & BEHAVIORAL DETECTION ───────────────────────────
//
// Two independent signals feed into IsBotClient:
//
//  1. DEVICE — Baileys' own getDevice(msg.key.id) predicts the client platform
//     from the message-ID format. A 'web'/'desktop' client that has never shown
//     any human interaction (typing/recording presence, or a prior message) is
//     treated as suspicious — real human web-clients almost always trigger a
//     'composing' presence at some point; pure automation frequently does not.
//
//  2. PRESENCE — real WhatsApp protocol has no way to block a message before it
//     is delivered (there is no ordering guarantee between presence.update and
//     messages.upsert). What IS possible: flag a JID the instant it does
//     something bot-shaped (composing with zero message history, or a first-ever
//     message with zero prior presence) and action its very next message
//     near-instantly. That is what "instant bot" below implements.

const { getDevice } = require('@crysnovax/baileys');

// key: `${botId}:${jid}` → { sawComposing: boolean, sawMessage: boolean, lastSeenAt: number }
const _identity = new Map();
// key: `${botId}:${jid}` → flaggedAt (ms) — expires after FLAG_TTL_MS
const _instantBotFlags = new Map();

const FLAG_TTL_MS = 60 * 1000;
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000; // stop tracking a JID after a day of silence

function _key(botId, jid) {
    return `${String(botId || 'global')}:${String(jid || '')}`;
}

function _getOrCreateIdentity(botId, jid) {
    const key = _key(botId, jid);
    let rec = _identity.get(key);
    if (!rec) {
        rec = { sawComposing: false, sawMessage: false, lastSeenAt: 0 };
        _identity.set(key, rec);
    }
    return rec;
}

/**
 * onPresence — call from a `presence.update` listener.
 * If the JID has never sent a message before and is now composing, that is
 * exactly the "about to spam" moment — flag it so the next message from this
 * JID is instantly actioned by the security pipeline, without waiting for
 * content-based checks to catch up.
 */
function onPresence(botId, jid, presences = {}) {
    const rec = _getOrCreateIdentity(botId, jid);
    const entries = Object.entries(presences || {});
    for (const [participantJid, info] of entries) {
        const isComposing = info?.lastKnownPresence === 'composing' || info?.lastKnownPresence === 'recording';
        if (!isComposing) continue;
        rec.sawComposing = true;
        rec.lastSeenAt = Date.now();
        if (!rec.sawMessage) {
            // Never messaged before, now composing — flag for instant action on next message.
            _instantBotFlags.set(_key(botId, participantJid || jid), Date.now());
        }
    }
}

/**
 * recordMessage — call once per incoming message so future presence/identity
 * checks know this JID has a real message history (i.e. is not a first-timer).
 */
function recordMessage(botId, jid) {
    const rec = _getOrCreateIdentity(botId, jid);
    rec.sawMessage = true;
    rec.lastSeenAt = Date.now();
}

/**
 * consumeInstantFlag — checks (and clears) whether this JID was flagged by a
 * suspicious presence event within the last FLAG_TTL_MS. One-shot: calling it
 * clears the flag so a single flagged moment doesn't action every subsequent
 * message forever.
 */
function consumeInstantFlag(botId, jid) {
    const key = _key(botId, jid);
    const flaggedAt = _instantBotFlags.get(key);
    if (!flaggedAt) return false;
    _instantBotFlags.delete(key);
    return (Date.now() - flaggedAt) <= FLAG_TTL_MS;
}

/**
 * classify — determine IsBotClient for an incoming message.
 *
 * @param {object} params
 * @param {string} params.botId
 * @param {string} params.jid — sender JID
 * @param {string} params.msgId — msg.key.id, used for device prediction
 * @param {boolean} params.isFirstMessageFromSender — true if this is the first
 *   message ever seen from this JID on this node (no message history at all —
 *   an "Instant Bot" per spec if it also skipped a composing presence event).
 * @returns {{ isBotClient: boolean, device: string, reason: string }}
 */
function classify({ botId, jid, msgId, isFirstMessageFromSender }) {
    const device = msgId ? getDevice(msgId) : 'unknown';
    const rec = _getOrCreateIdentity(botId, jid);

    // Signal A: flagged by a presence event moments ago (near-instant block).
    if (consumeInstantFlag(botId, jid)) {
        return { isBotClient: true, device, reason: 'Composed with no message history (presence-flagged)' };
    }

    // Signal B: first-ever message from this JID with zero prior presence at all —
    // never appeared as composing before this message landed. Per spec, this is
    // treated as an "Instant Bot" (a real human client almost always shows some
    // presence — typing indicator, read receipts — before or shortly after texting).
    if (isFirstMessageFromSender && !rec.sawComposing && (device === 'web' || device === 'desktop')) {
        return { isBotClient: true, device, reason: 'Instant message from web/desktop client with no prior presence' };
    }

    return { isBotClient: false, device, reason: '' };
}

// Periodic cleanup so these maps never grow unbounded on long-running nodes.
setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of _identity.entries()) {
        if (now - rec.lastSeenAt > IDENTITY_TTL_MS) _identity.delete(key);
    }
    for (const [key, flaggedAt] of _instantBotFlags.entries()) {
        if (now - flaggedAt > FLAG_TTL_MS) _instantBotFlags.delete(key);
    }
}, 10 * 60 * 1000).unref();

module.exports = { onPresence, recordMessage, classify, consumeInstantFlag };
