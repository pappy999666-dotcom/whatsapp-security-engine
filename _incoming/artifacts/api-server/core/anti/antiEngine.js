'use strict';
// core/anti/antiEngine.js
// ─── ANTI-SYSTEM PIPELINE ─────────────────────────────────────────────────────
//
// Single entry point: processAntiChecks(ctx) → { action, reason, module }
// All checks use the in-memory antiConfig cache — zero disk I/O on hot path.
//
// Execution order (strict):
//   1. antiLink          — WhatsApp invite links
//   2. antiCBroadcast    — channel-broadcast messages
//   3. antiBadword       — configured word list
//   4. antiBlasphemy     — hard-coded offensive patterns
//   5. antiSpam          — repeated identical messages
//   6. antiFlood         — high frequency from one sender
//   7. antiSticker       — sticker messages
//   8. antiAudio         — audio / PTT messages
//   9. antiVideo         — video messages
//  10. antiImage         — image messages
//  11. antiGif           — GIF/animated messages
//  12. antiDocument      — file/document messages
//  13. antiLocation      — location shares
//  14. antiContact       — vCard / contact messages
//  15. antiPoll          — poll messages
//  16. antiViewOnce      — view-once messages
//  17. antiForeignMedia  — media from outside contacts
//  18. antiMentionAll    — @everyone style mentions
//  19. antiForward       — forwarded messages
//  20. antiRevoke        — message deletion (delete for everyone)
//  21. antiDelete        — same as antiRevoke (alias)
//  22. antiBot           — messages from bots
//  23. antiIos           — iOS-platform messages
//  24. antiAndroid       — Android-platform messages
//  25. antiFakeid        — JIDs that look spoofed
//  26. antiSuspicious    — suspicious message patterns
//  27. antiScreen        — screenshots/screen-record events
//  28. antiLargeGroup    — membership threshold enforcement
//  29. antiPromote       — unauthorized promote events
//  30. antiLeave         — leave-group spam detection
//  31. antiJoin          — unwanted join events

const logger = require('../logger');
const { getAntiConfig, hasAnyAntiEnabled } = require('./antiConfig');
// Deep recursive protobuf link scanner — folded into antiLink so a single
// .antilink toggle also catches links hidden inside poll options, list rows,
// view-once wrappers, and common obfuscation ("site dot com", zero-width chars).
const deepLinkScan = require('./deepLinkScan');

// ─── Flood tracking: Map<groupJid, Map<senderJid, [timestamps]>> ─────────────
const _floodMap = new Map();
const FLOOD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [grp, senderMap] of _floodMap.entries()) {
        for (const [sender, timestamps] of senderMap.entries()) {
            const recent = timestamps.filter((t) => now - t < 60000);
            if (recent.length === 0) senderMap.delete(sender);
            else senderMap.set(sender, recent);
        }
        if (senderMap.size === 0) _floodMap.delete(grp);
    }
}, FLOOD_CLEANUP_INTERVAL_MS).unref();

// ─── Spam tracking: Map<senderJid, { hash, count, firstAt }> ─────────────────
const _spamMap = new Map();
const SPAM_WINDOW_MS = 30000;
const SPAM_COUNT_THRESHOLD = 4;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
    return h >>> 0;
}

const INVITE_LINK_RE = /(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?[A-Za-z0-9]{6,30}/gi;
const GENERIC_URL_RE = /(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi;
const EMOJI_RUN_RE = /(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\ufe0f?){2,}/gu;
const REALISTIC_COUNTRY_PREFIXES = new Set(['1','7','20','27','30','31','32','33','34','36','39','40','41','43','44','45','46','47','48','49','51','52','53','54','55','56','57','58','60','61','62','63','64','65','66','81','82','84','86','90','91','92','93','94','95','98','212','213','216','218','220','221','222','223','224','225','226','227','228','229','230','231','232','233','234','235','236','237','238','239','240','241','242','243','244','245','246','248','249','250','251','252','253','254','255','256','257','258','260','261','262','263','264','265','266','267','268','269','290','291','297','298','299','350','351','352','353','354','355','356','357','358','359','370','371','372','373','374','375','376','377','378','380','381','382','383','385','386','387','389','420','421','423','500','501','502','503','504','505','506','507','508','509','590','591','592','593','594','595','596','597','598','599','670','672','673','674','675','676','677','678','679','680','681','682','683','685','686','687','688','689','690','691','692','850','852','853','855','856','880','886','960','961','962','963','964','965','966','967','968','970','971','972','973','974','975','976','977','992','993','994','995','996','998']);

function _extractInviteLinks(text) {
    return String(text || '').match(INVITE_LINK_RE) || [];
}

function _extractLinks(text) {
    return String(text || '').match(GENERIC_URL_RE) || [];
}

function _isDomainAllowed(url, allowedDomains) {
    if (!allowedDomains?.length) return false;
    try {
        const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
        return allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    } catch {
        return false;
    }
}

// ─── Result builder ───────────────────────────────────────────────────────────
function _match(module, reason, action = 'delete_warn') {
    return { triggered: true, module, reason, action };
}

const _noop = { triggered: false };

// ─── Individual checks ────────────────────────────────────────────────────────

function checkAntiInviteLink(cfg, ctx) {
    if (!cfg.antiInviteLink && !cfg.antiLink) return _noop;
    // Deep scan first: catches invite links buried in poll options, list rows,
    // view-once wrappers, or hidden with obfuscation ("chat . whatsapp . com").
    if (ctx.rawMessage) {
        const scan = deepLinkScan.scanMessage(ctx.rawMessage);
        if (scan.inviteLinks.length) {
            const via = scan.source[0] ? ` (in: "${scan.source[0]}")` : '';
            return _match('antiInviteLink', `WhatsApp invite link detected: ${scan.inviteLinks[0]}${via}`);
        }
    }
    const links = _extractInviteLinks(ctx.text || ctx.caption || '');
    if (!links.length) return _noop;
    return _match('antiInviteLink', `WhatsApp invite link detected: ${links[0]}`);
}

function checkAntiLink(cfg, ctx) {
    if (!cfg.antiLink) return _noop;
    // Deep recursive protobuf scan (poll options, list rows, view-once, obfuscation).
    // This is the merged deep-antilink capability — no separate command needed.
    if (ctx.rawMessage) {
        const scan = deepLinkScan.scanMessage(ctx.rawMessage);
        const deepUnallowed = (scan.matches || []).filter((l) => !_isDomainAllowed(l, cfg.allowedDomains));
        if (deepUnallowed.length) {
            const via = scan.source[0] ? ` (in: "${scan.source[0]}")` : '';
            return _match('antiLink', `Hidden/obfuscated link detected: ${deepUnallowed[0]}${via}`);
        }
    }
    const text = ctx.text || ctx.caption || '';
    const links = _extractLinks(text).filter((l) => !/chat\.whatsapp\.com\//i.test(l));
    INVITE_LINK_RE.lastIndex = 0;
    if (!links.length) return _noop;
    const unallowed = links.filter((l) => !_isDomainAllowed(l, cfg.allowedDomains));
    if (!unallowed.length) return _noop;
    return _match('antiLink', `URL detected: ${unallowed[0]}`);
}


function checkAntiCaps(cfg, ctx) {
    if (!cfg.antiCaps) return _noop;
    const text = String(ctx.text || ctx.caption || '').replace(/[^a-zA-Z]/g, '');
    if (text.length < 12) return _noop;
    const caps = (text.match(/[A-Z]/g) || []).length;
    if (caps / text.length >= (cfg.capsThreshold || 0.75)) return _match('antiCaps', 'Excessive uppercase text');
    return _noop;
}

function checkAntiEmoji(cfg, ctx) {
    if (!cfg.antiEmoji) return _noop;
    const text = String(ctx.text || ctx.caption || '');
    for (const match of text.matchAll(EMOJI_RUN_RE)) {
        if ([...match[0]].length > (cfg.emojiThreshold || 8)) return _match('antiEmoji', 'Emoji flood detected');
    }
    return _noop;
}

function checkAntiMentionSpam(cfg, ctx) {
    if (!cfg.antiMentionSpam && !cfg.antiMentionAll) return _noop;
    const text = String(ctx.text || ctx.caption || '');
    const threshold = Number(cfg.mentionThreshold || 5);
    if (/@(everyone|all)\b/i.test(text) || (ctx.mentionedJids?.length || 0) > threshold)
        return _match('antiMentionSpam', 'Mass-mention detected');
    return _noop;
}

function checkAntiFakeNumber(cfg, ctx) {
    if (!cfg.antiFakeNumber) return _noop;
    const digits = String(ctx.senderJid || '').split('@')[0].replace(/\D/g, '');
    if (digits && ![1,2,3].some((n) => REALISTIC_COUNTRY_PREFIXES.has(digits.slice(0, n)))) return _match('antiFakeNumber', 'Unrealistic sender country code');
    return _noop;
}

function checkAntiForeignNumber(cfg, ctx) {
    if (!cfg.antiForeignNumber) return _noop;
    const allowed = (cfg.allowedPrefixes || []).map(String);
    if (!allowed.length) return _noop;
    const digits = String(ctx.senderJid || '').split('@')[0].replace(/\D/g, '');
    if (digits && !allowed.some((prefix) => digits.startsWith(prefix))) return _match('antiForeignNumber', 'Sender country prefix is not allowed');
    return _noop;
}

function checkAntiCBroadcast(cfg, ctx) {
    if (!cfg.antiCBroadcast) return _noop;
    // Channel-broadcast messages have a newsletter jid as participant
    if (ctx.isChannelBroadcast || ctx.messageType === 'newsletter') {
        return _match('antiCBroadcast', 'Channel-broadcast message blocked', 'delete');
    }
    return _noop;
}

const BLASPHEMY_RE = /\b(bitch|bastard|ass\s?hole|f+u+c+k+|c+u+n+t|whore|nigger)\b/i;

function checkAntiBadword(cfg, ctx) {
    if (!cfg.antiBadword) return _noop;
    const text = String(ctx.text || ctx.caption || '').toLowerCase();
    if (!text) return _noop;
    // Check configured word list first
    for (const w of (cfg.badwords || [])) {
        if (w && text.includes(w.toLowerCase())) {
            return _match('antiBadword', `Configured bad word detected: "${w}"`);
        }
    }
    return _noop;
}

function checkAntiBlasphemy(cfg, ctx) {
    if (!cfg.antiBlasphemy) return _noop;
    const text = String(ctx.text || ctx.caption || '');
    if (BLASPHEMY_RE.test(text)) {
        return _match('antiBlasphemy', 'Offensive language detected');
    }
    return _noop;
}

function checkAntiSpam(cfg, ctx) {
    if (!cfg.antiSpam) return _noop;
    const text = String(ctx.text || ctx.caption || '');
    if (!text || !ctx.senderJid) return _noop;

    const hash = _simpleHash(text);
    const now  = Date.now();
    const key  = `${ctx.groupJid}:${ctx.senderJid}`;
    const entry = _spamMap.get(key);

    if (!entry || entry.hash !== hash || now - entry.firstAt > SPAM_WINDOW_MS) {
        _spamMap.set(key, { hash, count: 1, firstAt: now });
        return _noop;
    }

    entry.count++;
    if (entry.count >= SPAM_COUNT_THRESHOLD) {
        _spamMap.delete(key);
        return _match('antiSpam', `Repeated message spam (${entry.count}×)`);
    }
    return _noop;
}

function checkAntiFlood(cfg, ctx) {
    if (!cfg.antiFlood) return _noop;
    const { groupJid, senderJid } = ctx;
    if (!groupJid || !senderJid) return _noop;

    const now    = Date.now();
    const window = cfg.floodLimitMs || 30000;
    const limit  = cfg.floodLimit   || 10;

    if (!_floodMap.has(groupJid)) _floodMap.set(groupJid, new Map());
    const sMap = _floodMap.get(groupJid);
    const ts   = (sMap.get(senderJid) || []).filter((t) => now - t < window);
    ts.push(now);
    sMap.set(senderJid, ts);

    if (ts.length > limit) {
        return _match('antiFlood', `Flood detected: ${ts.length} msgs in ${window}ms`, 'kick_warn');
    }
    return _noop;
}

function checkAntiMedia(cfg, ctx) {
    if (!cfg.antiMedia) return _noop;
    const mediaTypes = new Set(['image', 'video', 'audio', 'voice', 'ptt', 'sticker', 'gif', 'document']);
    if (mediaTypes.has(ctx.messageType) || ctx.isGif) return _match('antiMedia', 'Media message blocked');
    return _noop;
}

function checkAntiSticker(cfg, ctx) {
    if (!cfg.antiSticker) return _noop;
    if (ctx.messageType === 'sticker') return _match('antiSticker', 'Sticker blocked');
    return _noop;
}

function checkAntiAudio(cfg, ctx) {
    if (!cfg.antiAudio) return _noop;
    if (ctx.messageType === 'audio') return _match('antiAudio', 'Audio blocked');
    return _noop;
}

function checkAntiVoice(cfg, ctx) {
    if (!cfg.antiVoice) return _noop;
    if (ctx.messageType === 'voice' || ctx.messageType === 'ptt') return _match('antiVoice', 'Voice note blocked');
    return _noop;
}

function checkAntiVideo(cfg, ctx) {
    if (!cfg.antiVideo) return _noop;
    if (ctx.messageType === 'video') return _match('antiVideo', 'Video blocked');
    return _noop;
}

function checkAntiImage(cfg, ctx) {
    if (!cfg.antiImage) return _noop;
    if (ctx.messageType === 'image') return _match('antiImage', 'Image blocked');
    return _noop;
}

function checkAntiGif(cfg, ctx) {
    if (!cfg.antiGif) return _noop;
    if (ctx.messageType === 'gif' || ctx.isGif) return _match('antiGif', 'GIF blocked');
    return _noop;
}

function checkAntiDocument(cfg, ctx) {
    if (!cfg.antiDocument) return _noop;
    if (ctx.messageType === 'document') return _match('antiDocument', 'Document blocked');
    return _noop;
}

function checkAntiLocation(cfg, ctx) {
    if (!cfg.antiLocation) return _noop;
    if (ctx.messageType === 'location' || ctx.messageType === 'liveLocation')
        return _match('antiLocation', 'Location blocked');
    return _noop;
}

function checkAntiContact(cfg, ctx) {
    if (!cfg.antiContact) return _noop;
    if (ctx.messageType === 'contact' || ctx.messageType === 'contactsArray')
        return _match('antiContact', 'Contact share blocked');
    return _noop;
}

function checkAntiPoll(cfg, ctx) {
    if (!cfg.antiPoll) return _noop;
    if (ctx.messageType === 'poll' || ctx.messageType === 'pollCreation')
        return _match('antiPoll', 'Poll blocked');
    return _noop;
}

function checkAntiViewOnce(cfg, ctx) {
    if (!cfg.antiViewOnce) return _noop;
    if (ctx.isViewOnce) return _match('antiViewOnce', 'View-once message blocked');
    return _noop;
}

function checkAntiForeignMedia(cfg, ctx) {
    if (!cfg.antiForeignMedia) return _noop;
    if (ctx.isForeignMedia) return _match('antiForeignMedia', 'Media from non-contact blocked');
    return _noop;
}

function checkAntiMentionAll(cfg, ctx) {
    if (!cfg.antiMentionAll) return _noop;
    const text = String(ctx.text || ctx.caption || '');
    // Detect @everyone, @all, or a very large mention list
    if (/@(everyone|all)\b/i.test(text) || (ctx.mentionedJids?.length || 0) >= 10)
        return _match('antiMentionAll', 'Mass-mention detected');
    return _noop;
}

function checkAntiForward(cfg, ctx) {
    if (!cfg.antiForward) return _noop;
    if (ctx.isForwarded) return _match('antiForward', 'Forwarded message blocked');
    return _noop;
}

function checkAntiRevoke(cfg, ctx) {
    if (!cfg.antiRevoke) return _noop;
    if (ctx.messageType === 'revoke' || ctx.isRevoke)
        return _match('antiRevoke', 'Message deletion blocked', 'warn');
    return _noop;
}

function checkAntiDelete(cfg, ctx) {
    if (!cfg.antiDelete) return _noop;
    // antiDelete = re-send deleted message + warn
    if (ctx.isDeleted) return _match('antiDelete', 'Deleted message captured', 'resend_warn');
    return _noop;
}

function checkAntiBot(cfg, ctx) {
    if (!cfg.antiBot) return _noop;
    if (ctx.isBot || String(ctx.senderJid || '').endsWith(':0@s.whatsapp.net'))
        return _match('antiBot', 'Bot message blocked');
    return _noop;
}

function checkAntiIos(cfg, ctx) {
    if (!cfg.antiIos) return _noop;
    if (ctx.platform === 'ios' || ctx.platform === 'iphone')
        return _match('antiIos', 'iOS message blocked');
    return _noop;
}

function checkAntiAndroid(cfg, ctx) {
    if (!cfg.antiAndroid) return _noop;
    if (ctx.platform === 'android')
        return _match('antiAndroid', 'Android message blocked');
    return _noop;
}

function checkAntiFakeid(cfg, ctx) {
    if (!cfg.antiFakeid) return _noop;
    const jid = String(ctx.senderJid || '');
    // Fake JIDs often have unrealistic phone lengths or non-standard format
    if (!/^\d{7,15}@s\.whatsapp\.net$/.test(jid))
        return _match('antiFakeid', `Suspicious sender JID: ${jid}`, 'remove');
    return _noop;
}

function checkAntiSuspicious(cfg, ctx) {
    if (!cfg.antiSuspicious) return _noop;
    const text = String(ctx.text || ctx.caption || '');
    // Detect suspicious patterns: URL shorteners, phishing keywords
    const suspiciousRe = /(?:bit\.ly|tinyurl|goo\.gl|t\.co|ow\.ly|cutt\.ly)|\b(?:click here|verify now|account suspended|urgent action|claim prize)\b/i;
    if (suspiciousRe.test(text))
        return _match('antiSuspicious', 'Suspicious content detected');
    return _noop;
}

function checkAntiScreen(cfg, ctx) {
    if (!cfg.antiScreen) return _noop;
    if (ctx.isScreenshot || ctx.messageType === 'screenshot')
        return _match('antiScreen', 'Screenshot event blocked', 'warn');
    return _noop;
}

function checkAntiLargeGroup(cfg, ctx) {
    if (!cfg.antiLargeGroup) return _noop;
    const threshold = Number(process.env.ANTI_LARGE_GROUP_THRESHOLD || 500);
    if ((ctx.groupSize || 0) >= threshold)
        return _match('antiLargeGroup', `Group too large (${ctx.groupSize} members)`, 'leave');
    return _noop;
}

function checkAntiPromote(cfg, ctx) {
    if (!cfg.antiPromote) return _noop;
    if (ctx.event === 'promote' && !ctx.actorIsAdmin)
        return _match('antiPromote', 'Unauthorized promote event');
    return _noop;
}

function checkAntiLeave(cfg, ctx) {
    if (!cfg.antiLeave) return _noop;
    if (ctx.event === 'leave' && ctx.isSpamLeave)
        return _match('antiLeave', 'Leave-spam detected', 'log');
    return _noop;
}

function checkAntiJoin(cfg, ctx) {
    if (!cfg.antiJoin) return _noop;
    if (ctx.event === 'join' && ctx.isUnwantedJoin)
        return _match('antiJoin', 'Unwanted join blocked', 'remove');
    return _noop;
}

// ─── ORDERED CHECK PIPELINE ───────────────────────────────────────────────────
const PIPELINE = [
    checkAntiInviteLink,
    checkAntiLink,
    checkAntiCaps,
    checkAntiEmoji,
    checkAntiMentionSpam,
    checkAntiFakeNumber,
    checkAntiForeignNumber,
    checkAntiCBroadcast,
    checkAntiBadword,
    checkAntiBlasphemy,
    checkAntiSpam,
    checkAntiFlood,
    checkAntiMedia,
    checkAntiSticker,
    checkAntiAudio,
    checkAntiVoice,
    checkAntiVideo,
    checkAntiImage,
    checkAntiGif,
    checkAntiDocument,
    checkAntiLocation,
    checkAntiContact,
    checkAntiPoll,
    checkAntiViewOnce,
    checkAntiForeignMedia,
    checkAntiMentionAll,
    checkAntiForward,
    checkAntiRevoke,
    checkAntiDelete,
    checkAntiBot,
    checkAntiIos,
    checkAntiAndroid,
    checkAntiFakeid,
    checkAntiSuspicious,
    checkAntiScreen,
    checkAntiLargeGroup,
    checkAntiPromote,
    checkAntiLeave,
    checkAntiJoin,
];

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * processAntiChecks
 *
 * @param {object} ctx — normalized message context
 *   ctx.groupJid      — group JID
 *   ctx.senderJid     — sender JID
 *   ctx.text          — plain text body
 *   ctx.caption       — media caption
 *   ctx.messageType   — 'image' | 'video' | 'audio' | 'sticker' | etc.
 *   ctx.isForwarded   — boolean
 *   ctx.isViewOnce    — boolean
 *   ctx.isGif         — boolean
 *   ctx.isBot         — boolean
 *   ctx.isDeleted     — boolean
 *   ctx.isRevoke      — boolean
 *   ctx.isForeignMedia— boolean
 *   ctx.isChannelBroadcast — boolean
 *   ctx.mentionedJids — string[]
 *   ctx.groupSize     — number
 *   ctx.platform      — 'ios' | 'android' | etc.
 *   ctx.event         — 'join' | 'leave' | 'promote' | undefined
 *   ctx.actorIsAdmin  — boolean
 *   ctx.isSpamLeave   — boolean
 *   ctx.isUnwantedJoin— boolean
 *   ctx.isSenderAdmin — boolean (callers must NOT run checks on admins unless forced)
 *
 * @param {string} [botId] — this node's bot phone/JID, needed so getAntiConfig can
 *   bridge in pappy-admin's per-node flags (data/group_settings-{botId}.json).
 *   Node isolation: a group's config on node A never leaks into node B's checks.
 *
 * @returns {{ triggered: boolean, module?: string, reason?: string, action?: string }}
 */
function processAntiChecks(ctx, botId) {
    const { groupJid, isSenderAdmin } = ctx;

    // Admins are exempt from anti checks (owner already checked upstream)
    if (isSenderAdmin) return _noop;

    // Fast-exit: no anti config for this group
    if (!hasAnyAntiEnabled(groupJid, botId)) return _noop;

    const cfg = getAntiConfig(groupJid, botId);

    for (const check of PIPELINE) {
        try {
            const result = check(cfg, ctx);
            if (result.triggered) return result;
        } catch (err) {
            logger.warn(`[AntiEngine] check ${check.name} error: ${err.message}`);
        }
    }

    return _noop;
}

module.exports = {
    processAntiChecks,
    // Export individual checkers for unit testing
    checkAntiInviteLink,
    checkAntiLink,
    checkAntiCaps,
    checkAntiEmoji,
    checkAntiMentionSpam,
    checkAntiFakeNumber,
    checkAntiForeignNumber,
    checkAntiBadword,
    checkAntiBlasphemy,
    checkAntiSpam,
    checkAntiFlood,
    checkAntiMedia,
    checkAntiSticker,
    checkAntiAudio,
    checkAntiVoice,
    checkAntiVideo,
    checkAntiImage,
    checkAntiGif,
    checkAntiDocument,
    checkAntiLocation,
    checkAntiContact,
    checkAntiPoll,
    checkAntiViewOnce,
    checkAntiForeignMedia,
    checkAntiMentionAll,
    checkAntiForward,
    checkAntiRevoke,
    checkAntiDelete,
    checkAntiBot,
    checkAntiIos,
    checkAntiAndroid,
    checkAntiFakeid,
    checkAntiSuspicious,
    checkAntiScreen,
    checkAntiLargeGroup,
    checkAntiPromote,
    checkAntiLeave,
    checkAntiJoin,
    checkAntiCBroadcast,
};
