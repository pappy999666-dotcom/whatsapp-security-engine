'use strict';
// core/anti/antiHook.js
// Wires antiEngine.processAntiChecks into the message.upsert event bus.
// Runs AFTER pappy-admin daemon (which handles its own 7 flags).
// This hook handles the extended 31-check pipeline from antiEngine.

const eventBus        = require('../eventBus');
const logger          = require('../logger');
const { processAntiChecks } = require('./antiEngine');
const permissionEngine = require('../../modules/permissionEngine');

let _started = false;

function _getMsgType(msg) {
    const m = msg?.message || {};
    if (m.imageMessage)     return 'image';
    if (m.videoMessage)     return 'video';
    if (m.audioMessage)     return m.audioMessage.ptt ? 'voice' : 'audio';
    if (m.stickerMessage)   return 'sticker';
    if (m.documentMessage)  return 'document';
    if (m.locationMessage)  return 'location';
    if (m.contactMessage || m.contactsArrayMessage) return 'contact';
    if (m.pollCreationMessage || m.pollCreationMessageV3) return 'poll';
    if (m.viewOnceMessage || m.viewOnceMessageV2) return 'viewonce';
    if (m.extendedTextMessage?.contextInfo?.isForwarded) return 'text';
    return 'text';
}

function _isGif(msg) {
    const v = msg?.message?.videoMessage;
    return !!(v?.gifPlayback || v?.gifAttribution);
}

function _isViewOnce(msg) {
    return !!(msg?.message?.viewOnceMessage || msg?.message?.viewOnceMessageV2);
}

function _isForwarded(msg) {
    const ctx = msg?.message?.extendedTextMessage?.contextInfo
        || msg?.message?.imageMessage?.contextInfo
        || msg?.message?.videoMessage?.contextInfo;
    return !!(ctx?.isForwarded || (ctx?.forwardingScore > 0));
}

function _isChannelBroadcast(msg) {
    return !!(
        msg.key?.participant?.includes('newsletter') ||
        msg.message?.newsletterAdminInviteMessage ||
        msg.message?.channelMessage
    );
}

function _getPlatform(msg) {
    // Baileys exposes verifiedBizName or device info in some message types
    const agent = msg?.message?.extendedTextMessage?.contextInfo?.externalAdReply?.sourceType;
    if (agent) return String(agent).toLowerCase();
    return undefined;
}

function startAntiHook() {
    if (_started) return;
    _started = true;

    eventBus.on('message.upsert', async ({ sock, msg, text, isGroup, sender, botId, isGroupAdmin }) => {
        if (!isGroup || !msg?.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;

        // Whitelist: owner/sudo senders are always exempt
        if (permissionEngine.can(sender, botId, 'node_sudo')) return;

        const bodyText = String(text || msg.message?.conversation || msg.message?.extendedTextMessage?.text || '');
        const caption  = msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
        const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        // Do not resolve admin status here: anti delete must stay hot-path and
        // cannot wait on group metadata. The router payload may provide cached status.

        const ctx = {
            groupJid:          jid,
            senderJid:         sender,
            text:              bodyText,
            caption,
            messageType:       _getMsgType(msg),
            isForwarded:       _isForwarded(msg),
            isViewOnce:        _isViewOnce(msg),
            isGif:             _isGif(msg),
            isBot:             false, // antibot handled by pappy-admin daemon
            isDeleted:         false,
            isRevoke:          !!(msg.message?.protocolMessage?.type === 0),
            isForeignMedia:    false,
            isChannelBroadcast: _isChannelBroadcast(msg),
            mentionedJids:     mentions,
            groupSize:         0,
            platform:          _getPlatform(msg),
            isSenderAdmin:     !!isGroupAdmin,
        };

        try {
            const result = processAntiChecks(ctx, botId);
            if (!result?.triggered) return;

            // Delete fires immediately — fire-and-forget
            sock.sendMessage(jid, { delete: msg.key }).catch(() => {});

            logger.info(`[AntiHook] ${result.module} triggered for ${sender} in ${jid}: ${result.reason}`);
        } catch (err) {
            logger.warn(`[AntiHook] error: ${err.message}`);
        }
    });

    logger.info('[AntiHook] Anti engine pipeline wired to message.upsert');
}

module.exports = { startAntiHook };
