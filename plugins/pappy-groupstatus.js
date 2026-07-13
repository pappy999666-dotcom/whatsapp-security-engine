'use strict';
// plugins/pappy-groupstatus.js
// .updategstatus           -> group status ring on THIS group (run inside the group)
// .gstatus <link|jid> [count] [text] -> SPECIFIC group, N times, optional text/quoted msg
// .ggstatus [count]        -> ALL groups bot is in, N times
// .pstatus                 -> personal WhatsApp story (status@broadcast)
// .setstatus <text>        -> update bot account About/bio
// .getabout                -> read bot account About/bio
//
// richPreview: true — auto-fetches title, description, image from any URL in the status text.
// All status commands automatically detect URLs and enable richPreview.

const fs   = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@crysnovax/baileys');
const logger = require('../core/logger');
const { sendGroupStatus } = require('../core/gcstatus');
const { extractUrls } = require('../core/linkPreview');
const { renderGodcastTemplate } = require('../core/godcastTemplates');

const CONFIG_FILE    = path.join(__dirname, '../data/gs-config.json');
const DEFAULT_CONFIG = { backgroundColor: '#000000', font: 0 };
const gsConfigs      = new Map();

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return;
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        for (const [k, v] of Object.entries(saved || {})) gsConfigs.set(k, { ...DEFAULT_CONFIG, ...v });
    } catch {}
}
function saveConfig() {
    try {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(Object.fromEntries(gsConfigs), null, 2));
    } catch {}
}
loadConfig();

function getConfig(scope) {
    const key = String(scope || 'global');
    if (!gsConfigs.has(key)) gsConfigs.set(key, { ...DEFAULT_CONFIG });
    return gsConfigs.get(key);
}

function normalizeJid(jid) { return String(jid || '').replace(/:\d+@/, '@').trim(); }

function extractGroupJidFromInput(input) {
    const m = String(input || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    if (m) return { type: 'invite', code: m[1] };
    if (String(input || '').endsWith('@g.us')) return { type: 'jid', jid: input };
    return null;
}

async function downloadQuotedMedia(msg, sock) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return null;
    const qm = ctx.quotedMessage;
    if (!qm.imageMessage && !qm.videoMessage) return null;
    try {
        const buf = await downloadMediaMessage(
            { key: { remoteJid: ctx.remoteJid || msg.key.remoteJid, id: ctx.stanzaId, fromMe: false, participant: ctx.participant }, message: qm },
            'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage }
        );
        return { buffer: buf, isVideo: !!qm.videoMessage };
    } catch { return null; }
}

function buildContent(text, media, groupJid) {
    if (media) {
        const c = media.isVideo ? { video: media.buffer } : { image: media.buffer };
        if (text) c.caption = text;
        return c;
    }
    let finalText = text || '🔱';
    const content = {};
    if (text && extractUrls(text).length > 0) {
        // Wrap the link in the active godcast template when inside a group
        if (groupJid && groupJid.endsWith('@g.us')) {
            try {
                finalText = renderGodcastTemplate({ groupJid, inviteLink: text });
                logger.debug(`[GroupStatus] godcast template applied for ${groupJid}`);
            } catch (e) {
                logger.warn(`[GroupStatus] template render failed: ${e.message}`);
            }
        }
        content.richPreview = true;
        logger.debug(`[GroupStatus] richPreview enabled for URL in: ${text.slice(0, 60)}`);
    }
    content.text = finalText;
    return content;
}

async function getAllGroupJids(sock) {
    try {
        const raw = await require('../core/groupCache').getAllGroups(sock, true);
        return Object.values(raw).filter(g => g?.id?.endsWith('@g.us')).map(g => g.id);
    } catch { return []; }
}

module.exports = {
    category: 'STATUS',
    commands: [
        { cmd: '.updategstatus', role: 'admin' },
        { cmd: '.updatgstatus',  role: 'admin' },
        { cmd: '.gstatus',       role: 'owner' },
        { cmd: '.ggstatus',      role: 'owner' },
        { cmd: '.pstatus',       role: 'owner' },
        { cmd: '.setstatus',     role: 'owner' },
        { cmd: '.getabout',      role: 'owner' },
    ],

    getGsConfig: getConfig,

    execute: async ({ sock, msg, args, text, botId }) => {
        const chat     = msg.key.remoteJid;
        const rawCmd   = String(text || '').trim().split(/\s+/)[0].toLowerCase();
        const cmdName  = rawCmd === '.updatgstatus' ? '.updategstatus' : rawCmd;
        const restText = String(text || '').slice(cmdName.length).trim();
        const restArgs = restText.split(/\s+/).filter(Boolean);

        const quotedMsg  = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
        const media      = await downloadQuotedMedia(msg, sock);

        // sourceMessage: any extendedTextMessage is valid for likeThis relay —
        // covers link previews (matchedText), styled/coloured text (backgroundArgb/font),
        // and plain extended messages. Quoted takes priority over own message.
        const _ownExt = msg.message?.extendedTextMessage;

        let sourceMessage     = null;
        let sourceContextInfo = null;

        if (quotedMsg?.extendedTextMessage?.text != null) {
            sourceMessage     = { extendedTextMessage: quotedMsg.extendedTextMessage };
            sourceContextInfo = quotedMsg.extendedTextMessage.contextInfo || null;
            logger.info('[GroupStatus] sourceMessage: quoted extendedTextMessage');
        } else if (_ownExt?.text != null) {
            sourceMessage     = { extendedTextMessage: _ownExt };
            sourceContextInfo = _ownExt.contextInfo || null;
            logger.info('[GroupStatus] sourceMessage: own extendedTextMessage');
        }

        // ── .setstatus ────────────────────────────────────────────────────
        if (cmdName === '.setstatus') {
            const newAbout = restText || quotedText;
            if (!newAbout) return sock.sendMessage(chat, { text: '❌ Usage: `.setstatus <text>`' }, { quoted: msg });
            await sock.sendMessage(chat, { react: { text: '⏳', key: msg.key } }).catch(() => {});
            await sock.updateProfileStatus(newAbout);
            return sock.sendMessage(chat, { text: `✅ *About updated:* ${newAbout}` }, { quoted: msg });
        }

        // ── .getabout ─────────────────────────────────────────────────────
        if (cmdName === '.getabout') {
            try {
                const res = await sock.fetchStatus(normalizeJid(sock.user?.id || ''));
                return sock.sendMessage(chat, {
                    text: `📝 *About:* ${res?.status || '_(not set)_'}\n*Set at:* ${res?.setAt ? new Date(res.setAt * 1000).toLocaleString() : 'unknown'}`
                }, { quoted: msg });
            } catch (e) { return sock.sendMessage(chat, { text: `❌ Failed: ${e.message}` }, { quoted: msg }); }
        }

        // ── .updategstatus — THIS group ───────────────────────────────────
        if (cmdName === '.updategstatus') {
            if (!chat.endsWith('@g.us')) return sock.sendMessage(chat, { text: '❌ Run `.updategstatus` inside a group.' }, { quoted: msg });
            const content = buildContent(restText || quotedText, media, chat);
            await sock.sendMessage(chat, { react: { text: '📡', key: msg.key } }).catch(() => {});
            try {
                await sendGroupStatus(sock, chat, content, { sourceMessage, sourceContextInfo });
                return sock.sendMessage(chat, { text: '✅ *Group Status Posted*\n\n📍 Tap the group icon for the ring.' }, { quoted: msg });
            } catch (e) { return sock.sendMessage(chat, { text: `❌ Failed: ${e.message}` }, { quoted: msg }); }
        }

        // ── .gstatus <link|jid> [count] — SPECIFIC group ─────────────────
        if (cmdName === '.gstatus') {
            const target     = restArgs[0];
            const count      = Math.min(Math.max(1, parseInt(restArgs[1]) || 1), 10);
            const statusText = restArgs.slice(2).join(' ') || quotedText;
            if (!target) return sock.sendMessage(chat, { text: '❌ Usage: `.gstatus <link|jid> [count] [text]`' }, { quoted: msg });
            const parsed = extractGroupJidFromInput(target);
            if (!parsed) return sock.sendMessage(chat, { text: '❌ Invalid group link or JID.' }, { quoted: msg });
            let groupJid;
            if (parsed.type === 'invite') {
                try { const info = await sock.groupGetInviteInfo(parsed.code); groupJid = info?.id; if (!groupJid) throw new Error('no JID'); }
                catch (e) { return sock.sendMessage(chat, { text: `❌ Invalid invite: ${e.message}` }, { quoted: msg }); }
            } else { groupJid = parsed.jid; }
            const content   = buildContent(statusText, media);
            const statusMsg = await sock.sendMessage(chat, { text: `📡 Posting to *${groupJid.split('@')[0]}* ×${count}...` }, { quoted: msg });
            let ok = 0, fail = 0;
            for (let i = 0; i < count; i++) {
                try { await sendGroupStatus(sock, groupJid, content, { sourceMessage, sourceContextInfo }); ok++; }
                catch { fail++; }
                if (count > 1 && i < count - 1) await new Promise(r => setTimeout(r, 3000));
            }
            await sock.sendMessage(chat, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(chat, {
                text: `${ok > 0 ? '✅' : '❌'} *Group Status Done*\n✅ Sent: ${ok}  ❌ Failed: ${fail}\n\n📍 Tap the group icon for the ring.`
            }, { quoted: msg });
        }

        // ── .ggstatus [count] — ALL groups ───────────────────────────────
        if (cmdName === '.ggstatus') {
            const count      = Math.min(Math.max(1, parseInt(restArgs[0]) || 1), 5);
            const statusText = (parseInt(restArgs[0]) ? restArgs.slice(1) : restArgs).join(' ') || quotedText;
            const content    = buildContent(statusText, media);
            const allGroups  = await getAllGroupJids(sock);
            if (!allGroups.length) return sock.sendMessage(chat, { text: '❌ No groups found.' }, { quoted: msg });
            const statusMsg = await sock.sendMessage(chat, {
                text: `📡 Posting to *${allGroups.length} groups* ×${count}...\n_This will take a while._`
            }, { quoted: msg });
            let ok = 0, fail = 0;
            for (const groupJid of allGroups) {
                for (let i = 0; i < count; i++) {
                    try { await sendGroupStatus(sock, groupJid, content, { sourceMessage, sourceContextInfo }); ok++; }
                    catch { fail++; }
                    if (count > 1 && i < count - 1) await new Promise(r => setTimeout(r, 3000));
                }
                await new Promise(r => setTimeout(r, 2000));
            }
            await sock.sendMessage(chat, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(chat, {
                text: `✅ *ggstatus Done*\n📊 Groups: ${allGroups.length} ×${count}\n✅ Sent: ${ok}  ❌ Failed: ${fail}`
            }, { quoted: msg });
        }

        // ── .pstatus — personal story ─────────────────────────────────────
        if (cmdName === '.pstatus') {
            const content = buildContent(restText || quotedText || '🔱', media);
            try { await sock.updateStatusPrivacy('all'); } catch {}
            await sock.sendMessage(chat, { react: { text: '📡', key: msg.key } }).catch(() => {});
            try {
                await sock.sendMessage('status@broadcast', content);
                return sock.sendMessage(chat, { text: '✅ *Personal Story Posted*\n_Visible in WhatsApp Updates tab for 24h_' }, { quoted: msg });
            } catch (e) { return sock.sendMessage(chat, { text: `❌ Failed: ${e.message}` }, { quoted: msg }); }
        }
    },
};
