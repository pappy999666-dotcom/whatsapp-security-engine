'use strict';
// plugins/pappy-magic.js — "FLEX" suite: advanced @crysnovax/baileys tricks most bots don't do.
// Everything here is defensive + feature-detected: if the fork/WhatsApp build doesn't support a
// trick, the command fails gracefully with a clear message instead of crashing the node.
//
// NOTE: deliberately NO crash/"bug"/iOS-freeze payloads — those are abusive and get numbers banned.

const logger = require('../core/logger');
let downloadMediaMessage = null;
try { ({ downloadMediaMessage } = require('@crysnovax/baileys')); } catch {}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Pull the quoted message + its context out of the command message.
function getQuoted(msg) {
    const ctx = msg?.message?.extendedTextMessage?.contextInfo
        || msg?.message?.imageMessage?.contextInfo
        || msg?.message?.videoMessage?.contextInfo
        || null;
    const quotedMessage = ctx?.quotedMessage || null;
    return { ctx, quotedMessage };
}

// Build a delete/react/download key for a quoted message.
function quotedKey(msg, jid) {
    const { ctx } = getQuoted(msg);
    if (!ctx?.stanzaId) return null;
    return { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false };
}

// Unwrap nested message envelopes (viewOnce / ephemeral) down to the real media node.
function unwrap(message) {
    if (!message || typeof message !== 'object') return message;
    return message.viewOnceMessageV2?.message
        || message.viewOnceMessage?.message
        || message.viewOnceMessageV2Extension?.message
        || message.ephemeralMessage?.message
        || message;
}

module.exports = {
    category: 'MAGIC',
    commands: [
        { cmd: '.poll',       role: 'public' },
        { cmd: '.vv',         role: 'owner'  },
        { cmd: '.viewonce',   role: 'owner'  },
        { cmd: '.forward',    role: 'owner'  },
        { cmd: '.fakeverify', role: 'owner'  },
        { cmd: '.quote',      role: 'owner'  },
        { cmd: '.location',   role: 'public' },
        { cmd: '.vcard',      role: 'public' },
        { cmd: '.animate',    role: 'owner'  },
        { cmd: '.react',      role: 'admin'  },
        { cmd: '.tovn',       role: 'public' },
        { cmd: '.event',      role: 'owner'  },
        { cmd: '.btns',       role: 'owner'  },
        { cmd: '.list',       role: 'owner'  },
        { cmd: '.album',      role: 'owner'  },
    ],

    execute: async ({ sock, msg, args, text, botId }) => {
        const jid = msg.key.remoteJid;
        const cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase();
        const rest = args.join(' ').trim();
        const reply = (t, extra = {}) => sock.sendMessage(jid, { text: t, ...extra }, { quoted: msg });

        try {
            // ── .poll Question | Opt1 | Opt2 [| Opt3...] — native WhatsApp poll ──
            if (cmd === '.poll') {
                const parts = rest.split('|').map(s => s.trim()).filter(Boolean);
                if (parts.length < 3) return reply('🗳️ *Usage:* `.poll Question | Option 1 | Option 2 [| Option 3 ...]`');
                const [name, ...values] = parts;
                return sock.sendMessage(jid, {
                    poll: { name, values: values.slice(0, 12), selectableCount: 1 },
                });
            }

            // ── .vv / .viewonce — reveal a view-once photo/video/audio ──
            if (cmd === '.vv' || cmd === '.viewonce') {
                const { quotedMessage } = getQuoted(msg);
                if (!quotedMessage) return reply('👁️ *Reply to a view-once message* with `.vv` to reveal it.');
                if (!downloadMediaMessage) return reply('⚠️ Media engine unavailable on this build.');
                const inner = unwrap(quotedMessage);
                const media = inner?.imageMessage || inner?.videoMessage || inner?.audioMessage;
                if (!media) return reply('👁️ That message has no view-once media.');
                const key = quotedKey(msg, jid) || { remoteJid: jid, id: msg.key.id, fromMe: false };
                const buf = await downloadMediaMessage({ key, message: inner }, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                const caption = `👁️ *Revealed* ${media.caption ? '\n' + media.caption : ''}`.trim();
                if (inner.imageMessage) return sock.sendMessage(jid, { image: buf, caption }, { quoted: msg });
                if (inner.videoMessage) return sock.sendMessage(jid, { video: buf, caption }, { quoted: msg });
                return sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mp4', ptt: !!media.ptt }, { quoted: msg });
            }

            // ── .forward <text> — "Forwarded many times" badge ──
            if (cmd === '.forward') {
                if (!rest) return reply('↪️ *Usage:* `.forward <text>` (or reply to a message)');
                return sock.sendMessage(jid, {
                    text: rest,
                    contextInfo: { isForwarded: true, forwardingScore: 9999 },
                });
            }

            // ── .fakeverify <text> — message that appears to quote the official "WhatsApp" ──
            if (cmd === '.fakeverify') {
                if (!rest) return reply('✔️ *Usage:* `.fakeverify <text>`');
                const fakeQuoted = {
                    key: { remoteJid: jid, fromMe: false, id: 'BAE5' + Date.now(), participant: '0@s.whatsapp.net' },
                    message: { conversation: '✔️ Official • Verified by WhatsApp' },
                };
                return sock.sendMessage(jid, { text: rest }, { quoted: fakeQuoted });
            }

            // ── .quote <quoted text> | <your text> — fabricate a quoted reply from "WhatsApp" ──
            if (cmd === '.quote') {
                const [fake, real] = rest.split('|').map(s => s.trim());
                if (!fake || !real) return reply('💬 *Usage:* `.quote <fake quoted text> | <your reply>`');
                const fakeQuoted = {
                    key: { remoteJid: jid, fromMe: false, id: 'BAE5' + Date.now(), participant: '0@s.whatsapp.net' },
                    message: { conversation: fake },
                };
                return sock.sendMessage(jid, { text: real }, { quoted: fakeQuoted });
            }

            // ── .location <lat>,<lng> [| label] — drop a map pin ──
            if (cmd === '.location') {
                const [coords, label] = rest.split('|').map(s => s.trim());
                const m = String(coords || '').match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
                if (!m) return reply('📍 *Usage:* `.location <lat>,<lng> [| label]`\nExample: `.location 6.5244,3.3792 | Lagos`');
                return sock.sendMessage(jid, {
                    location: { degreesLatitude: parseFloat(m[1]), degreesLongitude: parseFloat(m[2]), name: label || undefined },
                });
            }

            // ── .vcard <name> | <number> — send a contact card ──
            if (cmd === '.vcard') {
                const [name, number] = rest.split('|').map(s => s.trim());
                const digits = String(number || '').replace(/[^0-9]/g, '');
                if (!name || !digits) return reply('👤 *Usage:* `.vcard <name> | <number>`');
                const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`;
                return sock.sendMessage(jid, { contacts: { displayName: name, contacts: [{ vcard }] } });
            }

            // ── .animate <text> — TYPEWRITER effect via live message edits (the showstopper) ──
            if (cmd === '.animate') {
                if (!rest) return reply('✨ *Usage:* `.animate <text>`');
                const words = rest.split(/\s+/).slice(0, 30); // cap frames to stay safe
                let sent;
                try { sent = await sock.sendMessage(jid, { text: '▎' }); } catch { return reply('⚠️ Could not start animation.'); }
                if (!sent?.key) return;
                let acc = '';
                for (let i = 0; i < words.length; i++) {
                    acc += (i ? ' ' : '') + words[i];
                    await delay(350);
                    await sock.sendMessage(jid, { text: acc + ' ▎', edit: sent.key }).catch(() => {});
                }
                await sock.sendMessage(jid, { text: acc, edit: sent.key }).catch(() => {});
                return;
            }

            // ── .react <emoji> — react to the replied message ──
            if (cmd === '.react') {
                const emoji = rest || '🔥';
                const key = quotedKey(msg, jid);
                if (!key) return reply('💫 *Reply to a message* with `.react <emoji>`');
                return sock.sendMessage(jid, { react: { text: emoji, key } });
            }

            // ── .tovn — convert a replied audio to a push-to-talk voice note ──
            if (cmd === '.tovn') {
                const { quotedMessage } = getQuoted(msg);
                const inner = unwrap(quotedMessage);
                if (!inner?.audioMessage) return reply('🎙️ *Reply to an audio file* with `.tovn`.');
                if (!downloadMediaMessage) return reply('⚠️ Media engine unavailable on this build.');
                const key = quotedKey(msg, jid);
                const buf = await downloadMediaMessage({ key, message: inner }, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                return sock.sendMessage(jid, { audio: buf, ptt: true, mimetype: 'audio/ogg; codecs=opus' }, { quoted: msg });
            }

            // ── .event <title> | <when> — native Event message (experimental, feature-detected) ──
            if (cmd === '.event') {
                const [title, when] = rest.split('|').map(s => s.trim());
                if (!title) return reply('📅 *Usage:* `.event <title> [| when]`');
                const startTs = Math.floor((when ? Date.parse(when) : Date.now() + 3600000) / 1000) || Math.floor(Date.now() / 1000) + 3600;
                try {
                    return await sock.sendMessage(jid, { event: { name: title, description: when || '', startTime: startTs } });
                } catch (e) {
                    logger.warn(`[Magic] event unsupported: ${e.message}`);
                    return reply('📅 Native events aren’t supported on this WhatsApp build.');
                }
            }

            // ── .btns Title | Body | Btn1 | Btn2 [| Btn3] — interactive quick-reply buttons ──
            if (cmd === '.btns') {
                const parts = rest.split('|').map(s => s.trim()).filter(Boolean);
                if (parts.length < 3) return reply('🔘 *Usage:* `.btns Title | Body | Button 1 | Button 2 [| Button 3]`');
                const [title, body, ...btns] = parts;
                const buttons = btns.slice(0, 3).map((b, i) => ({ buttonId: `pappy_btn_${i + 1}`, buttonText: { displayText: b }, type: 1 }));
                try {
                    // patchMessageBeforeSending wraps buttons/list in a viewOnce envelope so they
                    // render on builds that otherwise drop them.
                    return await sock.sendMessage(jid, { text: body, footer: title, buttons, headerType: 1 }, { quoted: msg });
                } catch (e) {
                    logger.warn(`[Magic] buttons unsupported: ${e.message}`);
                    return reply('🔘 Buttons aren’t supported on this WhatsApp build.');
                }
            }

            // ── .list Title | Body | ButtonText | row1, row2, row3 — sectioned list menu ──
            if (cmd === '.list') {
                const [title, body, btn, rowsRaw] = rest.split('|').map(s => s.trim());
                if (!title || !body || !rowsRaw) return reply('📋 *Usage:* `.list Title | Body | ButtonText | row1, row2, row3`');
                const rows = rowsRaw.split(',')
                    .map((r, i) => ({ title: r.trim(), rowId: `pappy_row_${i + 1}`, description: '' }))
                    .filter(r => r.title);
                if (!rows.length) return reply('📋 Add at least one comma-separated row.');
                const sections = [{ title, rows }];
                try {
                    return await sock.sendMessage(jid, { text: body, footer: title, title, buttonText: btn || 'Open', sections }, { quoted: msg });
                } catch (e) {
                    logger.warn(`[Magic] list unsupported: ${e.message}`);
                    return reply('📋 List menus aren’t supported on this WhatsApp build.');
                }
            }

            // ── .album <url1> <url2> [...] — send 2–10 images as a native album ──
            if (cmd === '.album') {
                const urls = rest.split(/\s+/).filter(u => /^https?:\/\//i.test(u)).slice(0, 10);
                if (urls.length < 2) return reply('🖼️ *Usage:* `.album <imgUrl1> <imgUrl2> [...]`  (2–10 image URLs)');
                const axios = require('axios');
                const bufs = [];
                for (const u of urls) {
                    try { const r = await axios.get(u, { responseType: 'arraybuffer', timeout: 15000 }); bufs.push(Buffer.from(r.data)); } catch {}
                }
                if (bufs.length < 2) return reply('🖼️ Could not fetch enough images for an album.');
                // Try the fork's native album first; fall back to a quick sequential drop.
                try {
                    return await sock.sendMessage(jid, { album: bufs.map(b => ({ image: b })) }, { quoted: msg });
                } catch (e) {
                    logger.warn(`[Magic] native album unsupported, sending sequentially: ${e.message}`);
                    for (let i = 0; i < bufs.length; i++) {
                        await sock.sendMessage(jid, { image: bufs[i], caption: i === 0 ? `🖼️ Album · ${bufs.length} images` : undefined }, { quoted: msg }).catch(() => {});
                        await delay(700);
                    }
                    return;
                }
            }
        } catch (err) {
            logger.error(`[Magic] ${cmd} failed: ${err.message}`);
            return reply(`⚠️ ${cmd} failed: ${err.message}`);
        }
    },
};
