'use strict';
// core/gcstatus.js — group-status sender.
//
// PATH 0  likeThis:true   — source/quoted message has an extendedTextMessage (link preview
//                           OR styled text). Relay the raw proto verbatim via likeThis.
//                           ext.text is overridden with postText so the command prefix is
//                           never included in the posted status.
// PATH A  media            — image/video content
// PATH B  richPreview:true — no WA extendedTextMessage (Telegram bridge, etc.) + URL found;
//                           Baileys auto-fetches title, description, image.
//                           groupStatus:true wraps as groupStatusMessageV2.
// PATH C  plain text       — no WA extendedTextMessage, no URL (Telegram bridge plain text).
//
// Ring routing is done via GROUP_STATUS_METADATA.additionalNodes on every path.

const logger          = require('./logger');
const { extractUrls } = require('./linkPreview');

function sourceText(sourceMessage) {
    if (!sourceMessage) return '';
    return sourceMessage.extendedTextMessage?.text || sourceMessage.conversation || '';
}

function findStatusUrl(postText, sourceMessage) {
    const fromText = extractUrls(String(postText || ''))[0];
    if (fromText) return fromText;
    const ext = sourceMessage?.extendedTextMessage;
    if (ext) {
        const fromMatched = ext.matchedText || ext.canonicalUrl || '';
        if (extractUrls(fromMatched)[0]) return extractUrls(fromMatched)[0];
        const fromSrcText = extractUrls(String(ext.text || ''))[0];
        if (fromSrcText) return fromSrcText;
    }
    return null;
}

// Routes the message to the group status ring.
const GROUP_STATUS_METADATA = {
    additionalNodes: [
        { tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined },
    ],
};

function asGroupStatusMessage(message) {
    return { groupStatusMessageV2: { message } };
}

async function sendGroupStatus(sock, groupJid, content, opts = {}) {
    if (!groupJid?.endsWith('@g.us')) throw new Error('Requires a valid @g.us JID');
    if (!sock?.user) throw new Error('Socket not connected');

    try { await sock.updateStatusPrivacy('all'); } catch {}

    const { sourceMessage = null } = opts;
    const ext = sourceMessage?.extendedTextMessage || null;

    // postText: always use content.text first (already stripped of the command prefix
    // by the plugin's restText/statusText logic), fall back to the source message text.
    const postText = (content.text != null && content.text !== '')
        ? String(content.text)
        : sourceText(sourceMessage);

    const explicitBg   = Number.isFinite(content?.backgroundArgb) ? content.backgroundArgb : null;
    const explicitFont = (content?.font !== undefined && content?.font !== null) ? content.font : null;
    const styleFields  = {
        ...(explicitBg   != null ? { backgroundArgb: explicitBg }   : {}),
        ...(explicitFont != null ? { font:           explicitFont } : {}),
    };

    // ── PATH 0: likeThis — relay existing WA-built extendedTextMessage ────────
    // Covers both link previews (matchedText set) and styled/coloured text statuses
    // (backgroundArgb / font set). If ext.text contains the bot command prefix we
    // override it with postText which the plugin already cleaned up.
    if (ext && ext.text) {
        const cleanText = postText || ext.text;
        const relayExt  = cleanText !== ext.text
            ? { ...ext, text: cleanText }
            : ext;

        logger.info(`[GCStatus] PATH 0: likeThis -> ${groupJid} | "${cleanText.slice(0, 60)}"`);

        const result = await sock.sendMessage(groupJid, {
            likeThis: true,
            ...asGroupStatusMessage({ extendedTextMessage: relayExt }),
        });

        logger.success(`[GCStatus] Ring (likeThis) -> ${groupJid}`);
        return result;
    }

    // ── PATH A: media status ──────────────────────────────────────────────────
    if (content.image || content.video) {
        logger.debug('[GCStatus] PATH A: media');
        const result = await sock.sendMessage(groupJid, { ...content, groupStatus: true });
        logger.info(`[GCStatus] Ring (media) -> ${groupJid}`);
        return result;
    }

    const statusUrl = findStatusUrl(postText, sourceMessage);

    // ── PATH B: Telegram bridge + URL — Baileys auto-fetches the preview ──────
    // groupStatus:true makes Baileys wrap as groupStatusMessageV2 and auto-inject
    // is_group_status:true inside relayMessage — no GROUP_STATUS_METADATA needed here,
    // passing it would create a duplicate meta node that causes WA to reject the message.
    if (statusUrl) {
        logger.info(`[GCStatus] PATH B: richPreview for ${statusUrl.slice(0, 60)}`);

        const result = await sock.sendMessage(groupJid, {
            text:        statusUrl,
            richPreview: true,
            groupStatus: true,
            ...styleFields,
        });

        logger.success(`[GCStatus] Ring (richPreview) -> ${groupJid}`);
        return result;
    }

    // ── PATH C: Telegram bridge plain text ────────────────────────────────────
    logger.debug(`[GCStatus] PATH C: plain text -> ${groupJid}`);

    const result = await sock.sendMessage(groupJid, {
        text: postText || '🔱',
        groupStatus: true,
        ...styleFields,
    });

    logger.info(`[GCStatus] Ring (plain) -> ${groupJid}`);
    return result;
}

module.exports = { sendGroupStatus };
