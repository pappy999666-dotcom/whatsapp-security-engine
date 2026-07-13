'use strict';
// plugins/pappy-extra.js — quick utility commands.
//   .save  — reply to any media to silently copy it to your own DM (status/disappearing-proof)
//   .ssweb — full-page screenshot of any website

const logger = require('../core/logger');
const { ownerWhatsAppJids } = require('../config');
let downloadMediaMessage = null;
try { ({ downloadMediaMessage } = require('@crysnovax/baileys')); } catch {}

// Unwrap viewOnce / ephemeral envelopes down to the real media node.
function unwrap(message) {
    if (!message || typeof message !== 'object') return message;
    return message.viewOnceMessageV2?.message
        || message.viewOnceMessage?.message
        || message.viewOnceMessageV2Extension?.message
        || message.ephemeralMessage?.message
        || message;
}

module.exports = {
    category: 'UTILITY',
    commands: [
        { cmd: '.save',  role: 'owner'  },
        { cmd: '.ssweb', role: 'public' },
    ],

    execute: async ({ sock, msg, args, text }) => {
        const jid = msg.key.remoteJid;
        const cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase();
        const reply = (t, extra = {}) => sock.sendMessage(jid, { text: t, ...extra }, { quoted: msg });

        try {
            // ── .save — copy a replied image/video/audio/file to the owner's DM ──
            if (cmd === '.save') {
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                const quoted = ctx?.quotedMessage;
                const inner = unwrap(quoted);
                const media = inner?.imageMessage || inner?.videoMessage || inner?.audioMessage || inner?.documentMessage;
                if (!media) return reply('💾 *Reply to an image, video, audio or file* with `.save`.');
                if (!downloadMediaMessage) return reply('⚠️ Media engine unavailable on this build.');

                const key = { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false };
                const buf = await downloadMediaMessage({ key, message: inner }, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });

                // Destination: the configured owner, else the bot's own number (self-chat).
                const selfJid = sock.user?.id ? `${String(sock.user.id).split(':')[0].split('@')[0]}@s.whatsapp.net` : jid;
                const dest = (ownerWhatsAppJids && ownerWhatsAppJids[0]) || selfJid;
                const cap = `💾 *Saved*${media.caption ? `\n${media.caption}` : ''}`;

                if (inner.imageMessage)      await sock.sendMessage(dest, { image: buf, caption: cap });
                else if (inner.videoMessage) await sock.sendMessage(dest, { video: buf, caption: cap });
                else if (inner.audioMessage) await sock.sendMessage(dest, { audio: buf, mimetype: inner.audioMessage.mimetype || 'audio/mp4', ptt: !!inner.audioMessage.ptt });
                else                          await sock.sendMessage(dest, { document: buf, mimetype: media.mimetype || 'application/octet-stream', fileName: media.fileName || 'pappy-save' });

                return reply('💾 *Saved to your DM.*');
            }

            // ── .ssweb <url> — website screenshot ──
            if (cmd === '.ssweb') {
                let url = args[0];
                if (!url) return reply('📸 *Usage:* `.ssweb <website url>`\nExample: `.ssweb github.com`');
                if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

                const axios = require('axios');
                const shot = `https://image.thum.io/get/width/1280/crop/1800/noanimate/${url}`;
                const wait = await sock.sendMessage(jid, { text: `📸 _Capturing_ ${url} …` }, { quoted: msg }).catch(() => null);
                try {
                    const r = await axios.get(shot, { responseType: 'arraybuffer', timeout: 30000 });
                    await sock.sendMessage(jid, { image: Buffer.from(r.data), caption: `📸 *Screenshot*\n${url}` }, { quoted: msg });
                    if (wait?.key) await sock.sendMessage(jid, { delete: wait.key }).catch(() => {});
                } catch (e) {
                    if (wait?.key) await sock.sendMessage(jid, { delete: wait.key }).catch(() => {});
                    return reply(`📸 Screenshot failed: ${e.message}`);
                }
                return;
            }
        } catch (err) {
            logger.error(`[Extra] ${cmd} failed: ${err.message}`);
            return reply(`⚠️ ${cmd} failed: ${err.message}`);
        }
    },
};
