'use strict';
// plugins/pappy-getdv.js — .getdv Intel Card
//
// Combines the target's WhatsApp profile picture with Truecaller metadata
// harvested from the local Python Flask microservice (truecaller-service/app.py).
//
// Target resolution priority: quoted message → @mention → raw number arg.
// Interfaces with the Flask service at TRUECALLER_API_URL (default
// http://localhost:5000/truecaller). This plugin never re-implements the
// Truecaller scraping logic — it only calls the microservice.

const axios = require('axios');
const logger = require('../core/logger');

const TRUECALLER_API_URL = process.env.TRUECALLER_API_URL || 'http://localhost:5000/truecaller';
const REQUEST_TIMEOUT_MS = 15000;

// Resolve the target JID from a quoted message, an @mention, or a raw number.
function resolveTargetJid(msg, args = []) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo
        || {};

    const mentioned = ctx.mentionedJid?.[0];
    if (mentioned) return mentioned;

    const quotedParticipant = ctx.participant;
    if (quotedParticipant) return quotedParticipant;

    const numeric = String(args[0] || '').replace(/[^0-9]/g, '');
    if (numeric.length >= 7) return `${numeric}@s.whatsapp.net`;

    return null;
}

// Pull the bare phone number out of a JID (drops the @server suffix + device id).
function jidToNumber(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

// Small helpers so the Intel Card never prints "undefined".
const val = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));
const yesNo = (v) => (v ? '⚠️ YES' : '✅ No');

module.exports = {
    category: 'INTEL',
    commands: [
        { cmd: '.getdv', role: 'admin' },
    ],

    execute: async ({ sock, msg, args }) => {
        const jid = msg.key.remoteJid;

        // 1. Resolve target -------------------------------------------------------
        const targetJid = resolveTargetJid(msg, args);
        if (!targetJid) {
            return sock.sendMessage(jid, {
                text: '  ⌬ *Usage:* `.getdv <number>` — or reply to / @tag a user.\n\n' +
                      'Examples:\n• `.getdv 919876543210`\n• reply to a message → `.getdv`\n• `.getdv @tag`',
            }, { quoted: msg });
        }

        const number = jidToNumber(targetJid);
        if (!number || number.length < 7) {
            return sock.sendMessage(jid, { text: '  ⌬ _Could not resolve a valid phone number from that target._' }, { quoted: msg });
        }

        // Progress ping so the operator knows the harvest started.
        await sock.sendMessage(jid, { text: `🛰️ *Harvesting intel* on +${number} …` }, { quoted: msg }).catch(() => {});

        // 2. Fetch WhatsApp PFP + Truecaller metadata in parallel -----------------
        const [waPfpUrl, tcData] = await Promise.all([
            sock.profilePictureUrl(targetJid, 'image').catch(() => null),
            axios.get(TRUECALLER_API_URL, {
                params: { number },
                timeout: REQUEST_TIMEOUT_MS,
            }).then((r) => r.data).catch((err) => {
                logger?.warn?.(`[getdv] Truecaller service error: ${err.message}`);
                return { error: err.response?.data?.error || err.message || 'service unreachable' };
            }),
        ]);

        // 3. Handle microservice failure gracefully -------------------------------
        if (!tcData || tcData.error) {
            const reason = tcData?.error || 'unknown error';
            const caption =
                '🪪 *INTEL CARD* (partial)\n' +
                '━━━━━━━━━━━━━━━━━━\n' +
                `📞 *Number:* +${number}\n` +
                `🔴 *Truecaller:* unavailable — _${reason}_\n` +
                '━━━━━━━━━━━━━━━━━━\n' +
                `_Is the Flask service running at ${TRUECALLER_API_URL}?_`;

            if (waPfpUrl) {
                return sock.sendMessage(jid, { image: { url: waPfpUrl }, caption }, { quoted: msg });
            }
            return sock.sendMessage(jid, { text: caption }, { quoted: msg });
        }

        // 4. Build the combined Intel Card ---------------------------------------
        const caption =
            '🪪 *INTEL CARD*\n' +
            '━━━━━━━━━━━━━━━━━━\n' +
            `👤 *Name:* ${val(tcData.name)}\n` +
            `📞 *Phone:* ${val(tcData.phone) !== '—' ? val(tcData.phone) : `+${number}`}\n` +
            `📡 *Carrier:* ${val(tcData.carrier)}\n` +
            `📧 *Email:* ${val(tcData.email)}\n` +
            `⚧ *Gender:* ${val(tcData.gender)}\n` +
            `🏙️ *City:* ${val(tcData.city)}\n` +
            `🌍 *Country:* ${val(tcData.country)}\n` +
            `🚨 *Flagged Fraud:* ${yesNo(tcData.isFraud)}\n` +
            '━━━━━━━━━━━━━━━━━━\n' +
            `🖼️ *WhatsApp PFP:* ${waPfpUrl ? 'attached ✅' : 'hidden / none 🔒'}\n` +
            `🗂️ *Truecaller Img:* ${tcData.image ? 'available' : '—'}`;

        // Prefer the WhatsApp PFP as the card image; fall back to Truecaller's.
        const imageUrl = waPfpUrl || tcData.image || null;

        try {
            if (imageUrl) {
                return await sock.sendMessage(jid, { image: { url: imageUrl }, caption }, { quoted: msg });
            }
            return await sock.sendMessage(jid, { text: caption }, { quoted: msg });
        } catch (err) {
            logger?.warn?.(`[getdv] Failed to send image card, falling back to text: ${err.message}`);
            return sock.sendMessage(jid, { text: caption }, { quoted: msg });
        }
    },
};
