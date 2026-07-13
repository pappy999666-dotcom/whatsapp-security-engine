'use strict';
// plugins/pappy-admin.js — Aggressive Group Protection Suite

const fsp    = require('fs').promises;
const path   = require('path');
const logger = require('../core/logger');
const eventBus = require('../core/eventBus');
const { guardGroupMetadataMutation } = require('../core/groupSafety');
const { ownerWhatsAppJids } = require('../config');
const linkPreviewCache = require('../core/linkPreviewCache');

function getDbPath(botId) {
    const digits = String(botId || '').replace(/[^0-9]/g, '');
    if (!digits) return path.join(__dirname, '../data/group_settings.json');
    return path.join(__dirname, `../data/group_settings-${digits}.json`);
}
const DB_PATH = path.join(__dirname, '../data/group_settings.json');
const SPAM_SHORT_WINDOW_MS = 4 * 1000;   // 4s short window (was 6s)
const SPAM_LONG_WINDOW_MS  = 30 * 1000;  // 30s long window
const LINK_WINDOW_MS       = 20 * 1000;  // 20s link window (was 30s)
const ACTION_COOLDOWN_MS   = 3 * 1000;   // 3s cooldown (was 8s)

// ─── GROUP META CACHE (shared central cache) ─────────────────────────────────
const groupCache = require('../core/groupCache');
async function getCachedGroupMeta(sock, jid) {
    return groupCache.getGroupMeta(sock, jid);
}

// ─── DB ──────────────────────────────────────────────────────────────────────
let _db = {};
let _writePending = false;

async function loadDb(botId) {
    const p = botId ? getDbPath(botId) : DB_PATH;
    try { _db = JSON.parse(await fsp.readFile(p, 'utf8')); } catch { _db = {}; }
}

async function saveDb(botId) {
    if (_writePending) return;
    _writePending = true;
    const p = botId ? getDbPath(botId) : DB_PATH;
    try { await fsp.writeFile(p, JSON.stringify(_db, null, 2), 'utf8'); }
    catch (e) { logger.error('[Admin] DB save failed', { error: e.message }); }
    finally { _writePending = false; }
}

function getScopedGroupKey(jid, botId) {
    const normalizedBotId = String(botId || '').replace(/[^0-9]/g, '') || 'global';
    return `${normalizedBotId}:${jid}`;
}

function getGroup(jid, botId) {
    // Lazy-load per-node db if not loaded yet
    const dbPath = getDbPath(botId);
    if (!_db._loadedFor || _db._loadedFor !== String(botId || '')) {
        try { Object.assign(_db, JSON.parse(require('fs').readFileSync(dbPath, 'utf8'))); } catch {}
        _db._loadedFor = String(botId || '');
    }
    const scopeKey = getScopedGroupKey(jid, botId);
    if (!_db[scopeKey]) _db[scopeKey] = {
        antilink: false, antibot: false, antigm: false,
        antispam: false, antichannel: false, antidemote: false,
        antigstatus: false,
        antidemoteMode: 'admins',
        antilinkAction: 'kick', antibotAction: 'kick',
        antigmAction: 'kick', antispamAction: 'warn',
        antichannelAction: 'kick', antigstatusAction: 'kick',
        warns: {}, spamTracker: {}, strictTracker: {},
        maxWarns: 3,
    };
    return _db[scopeKey];
}

function getContextInfoFromMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const directKeys = [
        'extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage',
        'buttonsResponseMessage', 'templateButtonReplyMessage', 'listResponseMessage'
    ];
    for (const key of directKeys) {
        const contextInfo = message[key]?.contextInfo;
        if (contextInfo) return contextInfo;
    }

    const nested = message.viewOnceMessage?.message
        || message.viewOnceMessageV2?.message
        || message.viewOnceMessageV2Extension?.message
        || null;
    return nested ? getContextInfoFromMessage(nested) : null;
}


function hasFastAntiEnabled(group) {
    return !!(
        group?.antilink || group?.antichannel || group?.antigstatus ||
        group?.antibot || group?.antigm || group?.antispam
    );
}

function resolveTargetJid(msg, args = []) {
    const contextInfo = getContextInfoFromMessage(msg?.message);
    const mentioned = contextInfo?.mentionedJid?.[0];
    if (mentioned) return mentioned;

    const repliedSender = contextInfo?.participant;
    if (repliedSender) return normalizeJid(repliedSender);

    const firstArgDigits = String(args[0] || '').replace(/[^0-9]/g, '');
    if (firstArgDigits) return `${firstArgDigits}@s.whatsapp.net`;
    return null;
}

function normalizeTextForDetection(text) {
    const raw = String(text || '').toLowerCase();
    return {
        raw,
        compact: raw
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, '')
            .replace(/[()\[\]{}<>]/g, ''),
    };
}

function detectLinks(text) {
    const { raw, compact } = normalizeTextForDetection(text);
    const patterns = [
        /https?:\/\//i,
        /www\./i,
        /(?:chat\.?whatsapp\.?com|wa\.me|t\.me|telegram\.me|discord\.gg|bit\.ly|tinyurl|cutt\.ly|rb\.gy)/i,
        /\b[a-z0-9-]+\.(?:com|net|org|io|co|xyz|me|ly|app|dev|gg|ai|biz)\b/i,
    ];
    const compactPatterns = [
        /chatwhatsappcom\/[a-z0-9]{10,}/i,
        /wame\/[0-9]{5,}/i,
    ];

    const hasLink = patterns.some((re) => re.test(raw)) || compactPatterns.some((re) => re.test(compact));
    const linkMatches = raw.match(/https?:\/\/\S+|www\.\S+|chat\.?whatsapp\.?com\/\S+|wa\.me\/\S+/gi) || [];
    return { hasLink, linkCount: Math.max(1, linkMatches.length) };
}

function isLikelyBotSpamMessage(sender, text, msg) {
    const raw = String(text || '');
    const rawLower = raw.toLowerCase();
    const senderStr = String(sender || '');

    let score = 0;

    // ── JID-level signals ─────────────────────────────────────────────────────
    // Device suffix in JID (e.g. 2348012345678:12@s.whatsapp.net) = multi-device bot
    if (/:\d+(?=@)/.test(senderStr)) score += 2;
    // JID ending in @lid = linked device / bot session
    if (senderStr.endsWith('@lid')) score += 2;
    // Bot JIDs often have very short or very long numeric prefixes
    const digits = senderStr.replace(/[^0-9]/g, '');
    if (digits.length > 15 || digits.length < 7) score += 1;

    // ── Explicit bot identity keywords ───────────────────────────────────────
    if (/\b(whatsapp.?bot|wa.?bot|md.?bot|base.?bot|multi.?device.?bot|powered by|bot by|deploy.?bot|pair.?code|scan.?qr|baileys|xmd|xstro|astro.?bot|pappy|kord|levanter|naze|hydra.?bot|techie|sigma.?bot|queen.?bot|king.?bot|prince.?bot|alpha.?bot|omega.?bot|ultra.?bot|prime.?bot|elite.?bot|nexus.?bot|matrix.?bot|cyber.?bot|ghost.?bot|shadow.?bot|dark.?bot|light.?bot|fire.?bot|ice.?bot|storm.?bot|thunder.?bot|lightning.?bot|flash.?bot|speed.?bot|turbo.?bot|rocket.?bot|jet.?bot|bullet.?bot|arrow.?bot|blade.?bot|sword.?bot|shield.?bot|armor.?bot|warrior.?bot|ninja.?bot|samurai.?bot|dragon.?bot|phoenix.?bot|titan.?bot|giant.?bot|monster.?bot|beast.?bot|demon.?bot|angel.?bot|god.?bot|devil.?bot|satan.?bot|lucifer.?bot|zeus.?bot|thor.?bot|odin.?bot|loki.?bot|ares.?bot|apollo.?bot|hermes.?bot|poseidon.?bot|hades.?bot|athena.?bot|artemis.?bot|aphrodite.?bot|hera.?bot|hephaestus.?bot|dionysus.?bot|persephone.?bot|demeter.?bot|hecate.?bot|iris.?bot|nike.?bot|tyche.?bot|nemesis.?bot|eros.?bot|psyche.?bot|ganymede.?bot|triton.?bot|proteus.?bot|nereus.?bot|thetis.?bot|amphitrite.?bot|doris.?bot|galatea.?bot|nereids.?bot|oceanids.?bot|naiads.?bot|dryads.?bot|hamadryads.?bot|oreads.?bot|nymphs.?bot)\b/i.test(rawLower)) score += 4;

    // ── GitHub / deployment links ─────────────────────────────────────────────
    if (/github\.com\/.+\/(bot|baileys|whatsapp|md|xmd|session)/i.test(raw)) score += 3;
    if (/replit\.com|render\.com|railway\.app|heroku\.com|koyeb\.com|cyclic\.sh/i.test(rawLower)) score += 2;

    // ── Pairing / session signals ─────────────────────────────────────────────
    if (/\b\d{3}[-\s]\d{3}\b/.test(raw) || /pair\s*code|session\s*id|creds\.json|auth_info/i.test(rawLower)) score += 3;

    // ── Command prefix at start of long message ───────────────────────────────
    // Bots often send their own command output or menus starting with . / ! # $
    if (/^[.!/\\#$*]\w/.test(raw.trim()) && raw.length > 80) score += 2;

    // ── Structural bot fingerprints ───────────────────────────────────────────
    // Excessive use of unicode box-drawing / decorative chars = bot menu
    const boxChars = (raw.match(/[┌┐└┘├┤┬┴┼─│╔╗╚╝╠╣╦╩╬═║▓▒░█▄▀■□●○◆◇★☆♦♣♠♥❤🔥⚡💫✨🌟💥⭐🎯👑🔱⚜️🏆🎖️🥇🎗️🎀🎁🎊🎉🎈🎆🎇🧨✅❌⚠️🚫🔴🟢🟡🔵⚫⚪🟤🟠🟣]/g) || []).length;
    if (boxChars > 8) score += 2;

    // Repeated separator lines (bot menus always have these)
    if (/([─═━─]{4,}|[*]{4,}|[-]{4,}|[~]{4,}|[=]{4,})/m.test(raw)) score += 1;

    // ── Zero-width / invisible character injection ────────────────────────────
    // Bots inject these to bypass duplicate detection
    if (/[\u200B-\u200F\u2060\uFEFF\u00AD]/g.test(raw)) score += 2;

    // ── Forwarding score ──────────────────────────────────────────────────────
    const ctxInfo = getContextInfoFromMessage(msg?.message);
    const forwardingScore = Number(ctxInfo?.forwardingScore || 0);
    if (forwardingScore >= 5) score += 1;
    if (forwardingScore >= 15 && /bot|pair|session|deploy|github/i.test(rawLower)) score += 3;

    // ── Message timing pattern (sent too fast = automated) ───────────────────
    // messageTimestamp is seconds since epoch; if message arrived < 1s after previous
    // from same sender that's a strong bot signal — tracked externally via spamTracker

    // ── No text but has suspicious media caption ──────────────────────────────
    const caption = String(msg?.message?.imageMessage?.caption || msg?.message?.videoMessage?.caption || '');
    if (caption && /bot|deploy|session|pair|github|baileys/i.test(caption)) score += 2;

    // ── Known bot broadcast patterns ─────────────────────────────────────────
    if (/\b(join (my|our|this) (group|channel|community)|subscribe|follow (me|us)|click (the )?(link|button)|limited (time|offer)|free (gift|reward|prize|money|airtime|data)|you (have been|are) (selected|chosen|invited)|congratulations you (won|have won)|claim (your|now)|verify (your|now)|account (suspended|blocked|limited)|urgent (action|notice|message)|act (now|fast|quickly))/i.test(rawLower)) score += 2;

    return score >= 4;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function kickUser(sock, jid, userJid) {
    await sock.groupParticipantsUpdate(jid, [userJid], 'remove');
}

async function warnUser(sock, jid, userJid, reason, group, botId) {
    if (!group.warns[userJid]) group.warns[userJid] = 0;
    group.warns[userJid]++;
    await saveDb(botId).catch(() => {});
    const count = group.warns[userJid];
    const max   = group.maxWarns || 3;
    await sock.sendMessage(jid, {
        text: `⚠️ @${userJid.split('@')[0]} has been warned.\n📌 Reason: ${reason}\n🔢 Warns: ${count}/${max}`,
        mentions: [userJid]
    });
    if (count >= max) {
        group.warns[userJid] = 0;
        await saveDb(botId).catch(() => {});
        await sock.sendMessage(jid, { text: `  ◈ *Max warns* ›› @${userJid.split("@")[0]} — removing.`, mentions: [userJid] });
        await kickUser(sock, jid, userJid).catch(() => {});
    }
}

async function deleteMsg(sock, msg) {
    await sock.sendMessage(msg.key.remoteJid, { delete: msg.key }).catch(() => {});
}

function buildQuotedDeleteKey(msg, jid) {
    const contextInfo = getContextInfoFromMessage(msg?.message);
    const stanzaId = contextInfo?.stanzaId;
    const participant = contextInfo?.participant;
    if (!stanzaId || !participant) return null;

    return {
        remoteJid: jid,
        id: stanzaId,
        participant,
        fromMe: false,
    };
}

async function deleteQuotedTargetMessage(sock, msg, jid) {
    const key = buildQuotedDeleteKey(msg, jid);
    if (!key) return false;
    await sock.sendMessage(jid, { delete: key }).catch(() => {});
    return true;
}

async function takeAction(sock, jid, userJid, action, reason, group, msg, botId) {
    await deleteMsg(sock, msg).catch(() => {});
    if (action === 'delete') return;
    // Lazy admin check — only needed before kick/warn
    try {
        const meta = await getCachedGroupMeta(sock, jid);
        const me   = `${botId}@s.whatsapp.net`;
        if (!groupCache.isAdminInMeta(meta, [me, sock.user?.lid])) return;
    } catch { return; }
    if (action === 'kick') {
        await sock.sendMessage(jid, { text: `🚫 @${userJid.split('@')[0]} was kicked.\n📌 Reason: ${reason}`, mentions: [userJid] });
        await kickUser(sock, jid, userJid).catch(() => {});
    } else if (action === 'warn') {
        await warnUser(sock, jid, userJid, reason, group, botId);
    }
}

loadDb(null).catch(() => {});

// ─── PROTECTION DAEMON ───────────────────────────────────────────────────────
let daemonStarted = false;
const antiDemoteListeners = new Set();

function normalizeJid(jid) {
    return String(jid || '').replace(/:\d+(?=@)/g, '').trim();
}

function buildOwnerSet() {
    const set = new Set();
    for (const j of ownerWhatsAppJids || []) {
        const norm = normalizeJid(j);
        if (!norm) continue;
        set.add(norm);
        set.add(norm.split('@')[0]);
    }
    return set;
}

function attachAntiDemoteListener(sock) {
    const botId = sock?.user?.id?.split(':')[0];
    if (!botId || antiDemoteListeners.has(botId)) return;
    antiDemoteListeners.add(botId);

    const ownerSet = buildOwnerSet();
    const botJid = `${botId}@s.whatsapp.net`;
    const isProtectedJid = (jid) => {
        const norm = normalizeJid(jid);
        const phone = norm.split('@')[0];
        return norm === botJid || ownerSet.has(norm) || ownerSet.has(phone);
    };

    sock.ev.on('group-participants.update', async ({ id, participants, action, author, actor, by }) => {
        if (action !== 'demote' || !id || !Array.isArray(participants) || !participants.length) return;

        const group = getGroup(id, botId);
        if (!group.antidemote) return;
        const mode = String(group.antidemoteMode || 'admins').toLowerCase();

        let meta = null;
        try {
            meta = await getCachedGroupMeta(sock, id);
        } catch {}

        const resolveActor = () => {
            const primary = normalizeJid(author || actor || by || '');
            if (primary) return primary;

            // Some payloads only carry a phone-like actor token; map it to group participant JID.
            const hint = String(author || actor || by || '').replace(/[^0-9]/g, '');
            if (!hint || !meta?.participants?.length) return '';
            const hit = meta.participants.find((p) => String(p?.id || '').replace(/[^0-9]/g, '') === hint);
            return normalizeJid(hit?.id || '');
        };
        const resolvedActor = resolveActor();

        for (const participant of participants) {
            const normalizedParticipant = normalizeJid(participant);
            const protectedTarget = isProtectedJid(normalizedParticipant);
            const shouldRestore = mode === 'admins' ? true : protectedTarget;
            if (!shouldRestore) continue;

            try {
                await sock.groupParticipantsUpdate(id, [normalizedParticipant], 'promote');
                const canPunishActor = !!resolvedActor && resolvedActor !== normalizedParticipant && !isProtectedJid(resolvedActor);

                if (canPunishActor) {
                    await sock.groupParticipantsUpdate(id, [resolvedActor], 'demote').catch(() => {});
                }

                const byPhone = String(resolvedActor || '').split('@')[0] || 'unknown';
                await sock.sendMessage(id, {
                    text: canPunishActor
                        ? `🛡️ AntiDemote restored @${normalizedParticipant.split('@')[0]} as admin.\n⚖️ @${byPhone} was demoted for unauthorized demotion.`
                        : `🛡️ AntiDemote restored @${normalizedParticipant.split('@')[0]} as admin.\nTriggered by: @${byPhone}`,
                    mentions: canPunishActor ? [normalizedParticipant, resolvedActor] : [normalizedParticipant],
                }).catch(() => {});
            } catch (err) {
                logger.warn('[Admin] AntiDemote restore failed', { groupId: id, participant: normalizedParticipant, actor: resolvedActor, error: err.message });
            }
        }
    });
}

function startDaemon() {
    if (daemonStarted) return;
    daemonStarted = true;

    eventBus.on('message.upsert', async ({ sock, msg, text, isGroup, sender, botId }) => {
        if (!isGroup || !msg?.message) return;
        const jid   = msg.key.remoteJid;
        const group = getGroup(jid, botId);
        if (!hasFastAntiEnabled(group) || msg.key.fromMe) return;

        const bodyText = String(text || msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '');
        const now = Date.now();

        if (!group.strictTracker || typeof group.strictTracker !== 'object') group.strictTracker = {};
        if (!group.strictTracker[sender]) {
            group.strictTracker[sender] = { msgTimes: [], shortMsgTimes: [], linkTimes: [], lastActionAt: 0, botHits: 0 };
        }
        const tracker = group.strictTracker[sender];
        tracker.msgTimes = (tracker.msgTimes || []).filter((t) => now - t < SPAM_LONG_WINDOW_MS);
        tracker.shortMsgTimes = (tracker.shortMsgTimes || []).filter((t) => now - t < SPAM_SHORT_WINDOW_MS);
        tracker.linkTimes = (tracker.linkTimes || []).filter((t) => now - t < LINK_WINDOW_MS);
        tracker.msgTimes.push(now);
        tracker.shortMsgTimes.push(now);

        const actionLocked = (now - Number(tracker.lastActionAt || 0)) < ACTION_COOLDOWN_MS;
        const { hasLink, linkCount } = detectLinks(bodyText);
        if (hasLink) {
            for (let i = 0; i < linkCount; i++) tracker.linkTimes.push(now);
        }

        // ── ANTILINK — STRICT: delete EVERY link instantly, no exceptions ─────
        // The delete is NEVER gated by the cooldown and is fire-and-forget, so a flood of
        // thousands of links is wiped with zero lag (each WA delete is queued by the socket).
        // Only the PUNISHMENT (kick/warn announcement) is throttled, so we don't spam it.
        if (group.antilink && hasLink) {
            deleteMsg(sock, msg).catch(() => {}); // instant silent delete — not awaited, not cooldown-gated
            if (!actionLocked) {
                tracker.lastActionAt = now;
                takeAction(sock, jid, sender, group.antilinkAction, 'Sending links is not allowed', group, msg, botId).catch(() => {});
            }
            return;
        }

        // ── ANTICHANNEL — silent delete first ────────────────────────────────
        if (group.antichannel) {
            const isChannel = msg.key.participant?.includes('newsletter') ||
                msg.message?.extendedTextMessage?.contextInfo?.forwardingScore > 5 ||
                !!(msg.message?.newsletterAdminInviteMessage) ||
                !!(msg.message?.channelMessage);
            if (isChannel) {
                deleteMsg(sock, msg).catch(() => {});
                takeAction(sock, jid, sender, group.antichannelAction, 'Channel messages not allowed', group, msg, botId).catch(() => {});
                return;
            }
        }

        // ── ANTIGSTATUS — detect all group status types, delete silently ─────
        if (group.antigstatus) {
            const isGStatus = !!(msg.message?.groupStatusMessageV2) ||
                !!(msg.message?.groupStatusMessage) ||
                !!(msg.message?.statusMessage) ||
                !!(msg.message?.groupStatusUpdateV2) ||
                msg.key?.remoteJid?.endsWith('@broadcast') ||
                (msg.key?.participant === undefined && !!msg.message?.ephemeralMessage);
            if (isGStatus) {
                deleteMsg(sock, msg).catch(() => {});
                tracker.lastActionAt = now;
                takeAction(sock, jid, sender, group.antigstatusAction, 'Group status updates are not allowed', group, msg, botId).catch(() => {});
                return;
            }
        }

        // ── ANTIBOT — silent delete + punish ─────────────────────────────────
        if (group.antibot) {
            const botLike = isLikelyBotSpamMessage(sender, bodyText, msg);
            if (botLike) {
                deleteMsg(sock, msg).catch(() => {});
                tracker.botHits = Number(tracker.botHits || 0) + 1;
                tracker.lastActionAt = now;
                takeAction(sock, jid, sender, group.antibotAction, 'Automated bot-like behavior detected', group, msg, botId).catch(() => {});
                return;
            }
        }

        // ── ANTIGM (anti-group-mention / mass tag) — silent delete ───────────
        if (group.antigm) {
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
                msg.message?.groupMentionedMessage?.contextInfo?.mentionedJid || [];
            if (mentions.length >= 1) {
                deleteMsg(sock, msg).catch(() => {});
                tracker.lastActionAt = now;
                takeAction(sock, jid, sender, group.antigmAction, 'Tagging group members is not allowed', group, msg, botId).catch(() => {});
                return;
            }
        }

        // ── ANTISPAM — tightened thresholds, silent delete ────────────────────
        if (group.antispam && !actionLocked) {
            if (!group.spamTracker[sender]) group.spamTracker[sender] = [];
            group.spamTracker[sender] = group.spamTracker[sender].filter(t => now - t < 5000);
            group.spamTracker[sender].push(now);

            const shortBurst       = tracker.shortMsgTimes.length >= 7;  // 7 msgs in 4s (was 10/6s)
            const longBurst        = tracker.msgTimes.length >= 18;       // 18 msgs in 30s (was 25/30s)
            const hardLinkFlood    = tracker.linkTimes.length >= 3;       // 3 links in 20s (was 8/30s)
            const configuredSpamHit = group.spamTracker[sender].length >= 4; // 4 in 5s (was 6)

            if (shortBurst || longBurst || hardLinkFlood || configuredSpamHit) {
                deleteMsg(sock, msg).catch(() => {});
                group.spamTracker[sender] = [];
                tracker.lastActionAt = now;
                takeAction(sock, jid, sender, group.antispamAction, 'Spamming is not allowed', group, msg, botId).catch(() => {});
                return;
            }
        }
    });
}

// ─── MODULE ──────────────────────────────────────────────────────────────────
module.exports = {
    category: 'ADMIN',
    commands: [
        // Protection toggles
        // Anti system
        { cmd: '.antilink',       role: 'admin' },
        { cmd: '.antibot',        role: 'admin' },
        { cmd: '.antigm',         role: 'admin' },
        { cmd: '.antispam',       role: 'admin' },
        { cmd: '.antichannel',    role: 'admin' },
        { cmd: '.antidemote',     role: 'owner' },
        { cmd: '.antigstatus',    role: 'admin' },
        { cmd: '.antimodes',      role: 'admin' },
        // Action setters
        { cmd: '.setaction',      role: 'admin' },
        // Moderation
        { cmd: '.kick',           role: 'admin' },
        { cmd: '.warn',           role: 'admin' },
        { cmd: '.warns',          role: 'admin' },
        { cmd: '.resetwarn',      role: 'admin' },
        { cmd: '.delete',         role: 'admin' },
        { cmd: '.dlt',            role: 'admin' },
        { cmd: '.deleteall',      role: 'admin' },
        { cmd: '.ban',            role: 'admin' },
        { cmd: '.unban',          role: 'admin' },
        { cmd: '.accept',         role: 'admin' },
        { cmd: '.acceptall',      role: 'admin' },
        { cmd: '.rejectall',      role: 'admin' },
        { cmd: '.reject',         role: 'admin' },
        { cmd: '.stoprequest',    role: 'admin' },
        { cmd: '.promote',        role: 'admin' },
        { cmd: '.demote',         role: 'admin' },
        { cmd: '.mute',           role: 'admin' },
        { cmd: '.unmute',         role: 'admin' },
        { cmd: '.groupsettings',  role: 'admin' },
        { cmd: '.setgrppfp',      role: 'admin' },
        { cmd: '.tag',            role: 'owner' },
        { cmd: '.setmypfp',       role: 'owner' },
        { cmd: '.setpfp',         role: 'owner' },
        { cmd: '.delpfp',         role: 'owner' },
        { cmd: '.setname',        role: 'owner' },
        { cmd: '.fullpfp',        role: 'public' },
        // Group management
        { cmd: '.grouplink',      role: 'admin' },
        { cmd: '.revoke',         role: 'admin' },
        { cmd: '.hidetag',        role: 'owner' },
        { cmd: '.clearwarns',     role: 'admin' },
        { cmd: '.memberlist',     role: 'admin' },
        { cmd: '.disappear',      role: 'admin' },
        { cmd: '.groupinfo',      role: 'admin' },
        { cmd: '.setgroupname',   role: 'admin' },
        { cmd: '.setgroupdesc',   role: 'admin' },
        { cmd: '.locksettings',   role: 'admin' },
        { cmd: '.unlocksettings', role: 'admin' },
        { cmd: '.maxwarn',        role: 'admin' },
        // Baileys tricks
        { cmd: '.edit',           role: 'owner' },
        { cmd: '.ghostmode',      role: 'owner' },
    ],

    init: (sock) => {
        startDaemon();
        if (sock) attachAntiDemoteListener(sock);
    },

    execute: async ({ sock, msg, args, text, user, botId }) => {
        const jid   = msg.key.remoteJid;
        const cmd   = text.split(' ')[0].toLowerCase();
        const group = getGroup(jid, botId);

        // Resolve target by: mention -> reply target -> numeric arg
        const mentioned = resolveTargetJid(msg, args);

        // ── ANTIMODES — table view of all anti-system settings ───────────────
        if (cmd === '.antimodes') {
            if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            return sock.sendMessage(jid, {
                title: '🛡️ ANTI SYSTEM',
                headerText: '## Group Protection Modes',
                contentText: '---',
                table: [
                    ['Feature', 'Status', 'Action'],
                    ['AntiLink',    group.antilink    ? '✅ ON' : '🔴 OFF', group.antilinkAction    || 'kick'],
                    ['AntiBot',     group.antibot     ? '✅ ON' : '🔴 OFF', group.antibotAction     || 'kick'],
                    ['AntiSpam',    group.antispam    ? '✅ ON' : '🔴 OFF', group.antispamAction    || 'warn'],
                    ['AntiGM',      group.antigm      ? '✅ ON' : '🔴 OFF', group.antigmAction      || 'kick'],
                    ['AntiChannel', group.antichannel ? '✅ ON' : '🔴 OFF', group.antichannelAction || 'kick'],
                    ['AntiDemote',  group.antidemote  ? '✅ ON' : '🔴 OFF', group.antidemoteMode    || 'admins'],
                    ['AntiGStatus', group.antigstatus ? '✅ ON' : '🔴 OFF', group.antigstatusAction || 'kick'],
                ],
                noHeading: false,
                footerText: 'Use .setaction <feature> <kick|warn|delete> to change action',
            }, { quoted: msg });
        }

        // ── GROUP INFO ────────────────────────────────────────────────────────
        if (cmd === '.groupinfo') {
            if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            try {
                const meta = await getCachedGroupMeta(sock, jid);
                const admins   = meta.participants.filter(p => p.admin).length;
                const members  = meta.participants.length;
                const creation = meta.creation ? new Date(meta.creation * 1000).toLocaleDateString() : '—';
                const restrict = meta.restrict ? '🔒 Admins Only' : '🔓 Everyone';
                const announce = meta.announce  ? '🔒 Admins Only' : '🔓 Everyone';
                return sock.sendMessage(jid, {
                    title: '📋 GROUP INFO',
                    headerText: '## Group Details',
                    contentText: '---',
                    table: [
                        ['Field', 'Value'],
                        ['📛 Name',     meta.subject || '—'],
                        ['👥 Members',  String(members)],
                        ['👑 Admins',   String(admins)],
                        ['📅 Created',  creation],
                        ['✏️ Edit Info', restrict],
                        ['💬 Send Msgs', announce],
                        ['🔗 Ephemeral', meta.ephemeralDuration ? `${meta.ephemeralDuration}s` : 'Off'],
                    ],
                    noHeading: false,
                    footerText: meta.desc ? `📝 ${String(meta.desc).slice(0, 80)}` : 'No description set.',
                }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── SET GROUP NAME ────────────────────────────────────────────────────
        if (cmd === '.setgroupname') {
            if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            const newName = args.join(' ').trim();
            if (!newName) return sock.sendMessage(jid, { text: '  ◈ *Usage:* `.setgroupname <new name>`' }, { quoted: msg });
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'subject' });
            if (!gate.ok) return sock.sendMessage(jid, { text: `  ⟡ _cooldown — retry in ${Math.ceil((gate.waitMs || 0) / 1000)}s._` }, { quoted: msg });
            try {
                await sock.groupUpdateSubject(jid, newName);
                return sock.sendMessage(jid, { text: `  ✅ *Group name* updated to: *${newName}*` }, { quoted: msg });
            } catch (e) { return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg }); }
        }

        // ── SET GROUP DESCRIPTION ─────────────────────────────────────────────
        if (cmd === '.setgroupdesc') {
            if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            const newDesc = args.join(' ').trim()
                || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || '';
            if (!newDesc) return sock.sendMessage(jid, { text: '  ◈ *Usage:* `.setgroupdesc <description>`' }, { quoted: msg });
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'description' });
            if (!gate.ok) return sock.sendMessage(jid, { text: `  ⟡ _cooldown — retry in ${Math.ceil((gate.waitMs || 0) / 1000)}s._` }, { quoted: msg });
            try {
                await sock.groupUpdateDescription(jid, newDesc);
                return sock.sendMessage(jid, { text: `  ✅ *Group description* updated.` }, { quoted: msg });
            } catch (e) { return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg }); }
        }

        // ── LOCK / UNLOCK GROUP SETTINGS ──────────────────────────────────────
        if (cmd === '.locksettings') {
            if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'locked' });
            if (!gate.ok) return sock.sendMessage(jid, { text: `  ⟡ _cooldown — retry in ${Math.ceil((gate.waitMs || 0) / 1000)}s._` }, { quoted: msg });
            try {
                await sock.groupSettingUpdate(jid, 'locked');
                return sock.sendMessage(jid, { text: '  🔒 *Group settings locked* — only admins can edit group info.' }, { quoted: msg });
            } catch (e) { return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg }); }
        }

        if (cmd === '.unlocksettings') {
            if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'unlocked' });
            if (!gate.ok) return sock.sendMessage(jid, { text: `  ⟡ _cooldown — retry in ${Math.ceil((gate.waitMs || 0) / 1000)}s._` }, { quoted: msg });
            try {
                await sock.groupSettingUpdate(jid, 'unlocked');
                return sock.sendMessage(jid, { text: '  🔓 *Group settings unlocked* — all members can edit group info.' }, { quoted: msg });
            } catch (e) { return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg }); }
        }

        // ── SET MAX WARNS ─────────────────────────────────────────────────────
        if (cmd === '.maxwarn') {
            if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            const val = parseInt(args[0]);
            if (!val || val < 1 || val > 20) return sock.sendMessage(jid, { text: '  ◈ *Usage:* `.maxwarn <1-20>`' }, { quoted: msg });
            group.maxWarns = val;
            await saveDb(botId);
            return sock.sendMessage(jid, { text: `  ✅ *Max warns* set to *${val}* — members are kicked after ${val} warn(s).` }, { quoted: msg });
        }

        // ── PROTECTION TOGGLES ────────────────────────────────────────────────
        const toggleMap = {
            '.antilink': 'antilink', '.antibot': 'antibot',
            '.antigm': 'antigm', '.antispam': 'antispam', '.antichannel': 'antichannel',
            '.antidemote': 'antidemote',
            '.antigstatus': 'antigstatus'
        };

        if (toggleMap[cmd]) {
            const key    = toggleMap[cmd];
            const action = String(args[0] || '').toLowerCase();

            const isEnabledWord = ['on', 'enable', 'enabled', 'true', '1'].includes(action);
            const isDisabledWord = ['off', 'disable', 'disabled', 'false', '0'].includes(action);

            if (cmd === '.antidemote' && action === 'mode') {
                const modeArg = String(args[1] || '').toLowerCase();
                if (!['protected', 'admins'].includes(modeArg)) {
                    return sock.sendMessage(jid, {
                        text: '❌ Usage: .antidemote mode <protected|admins>\n• protected = only owner/bot protected targets\n• admins = any group admin demotion triggers restore + punishment'
                    }, { quoted: msg });
                }
                group.antidemoteMode = modeArg;
                await saveDb(botId);
                return sock.sendMessage(jid, {
                    text: `✅ *ANTIDEMOTE MODE* set to *${modeArg.toUpperCase()}*`
                }, { quoted: msg });
            }

            if (isEnabledWord || isDisabledWord || action === 'toggle') {
                const nextState = action === 'toggle' ? !group[key] : isEnabledWord;
                group[key] = nextState;
                if (key === 'antigstatus') {
                    try { require('../core/anti/antiConfig').setAntiFlag(jid, 'antiGStatus', nextState); } catch {}
                }
                if (cmd === '.antidemote' && group[key] && !group.antidemoteMode) {
                    group.antidemoteMode = 'admins';
                }
                if (group[key] && key === 'antispam') group.antispamAction = 'kick';
                if (group[key] && key === 'antilink') group.antilinkAction = 'kick';
                await saveDb(botId);
                return sock.sendMessage(jid, {
                    text: cmd === '.antidemote'
                        ? `${group[key] ? '✅' : '🔴'} *ANTIDEMOTE* is now *${group[key] ? 'ON' : 'OFF'}*\n🧭 Mode: *${String(group.antidemoteMode || 'protected').toUpperCase()}*`
                        : `${group[key] ? '✅' : '🔴'} *${cmd.slice(1).toUpperCase()}* is now *${group[key] ? 'ON' : 'OFF'}*\n⚙️ Action: *${group[key + 'Action'] || 'kick'}*`
                }, { quoted: msg });
            }
            return sock.sendMessage(jid, {
                text: cmd === '.antidemote'
                    ? `⚙️ *ANTIDEMOTE* Status: ${group[key] ? '✅ ON' : '🔴 OFF'}\n🧭 Mode: *${String(group.antidemoteMode || 'protected').toUpperCase()}*\n\nUsage:\n• .antidemote on/off\n• .antidemote mode <protected|admins>`
                    : `⚙️ *${cmd.slice(1).toUpperCase()}* Status: ${group[key] ? '✅ ON' : '🔴 OFF'}\nAction: *${group[key + 'Action'] || 'kick'}*\n\nUsage: ${cmd} on/off | toggle`
            }, { quoted: msg });
        }

        // ── SET ACTION ────────────────────────────────────────────────────────
        if (cmd === '.setaction') {
            // .setaction antilink kick|warn|delete
            const feature = args[0]?.toLowerCase();
            const action  = args[1]?.toLowerCase();
            const validFeatures = ['antilink', 'antibot', 'antigm', 'antispam', 'antichannel', 'antigstatus'];
            const validActions  = ['kick', 'warn', 'delete'];
            if (!validFeatures.includes(feature) || !validActions.includes(action)) {
                return sock.sendMessage(jid, { text: '  ◈ *Usage:* `.setaction antilink kick|warn|delete`' }, { quoted: msg });
            }
            group[feature + 'Action'] = action;
            await saveDb(botId);
            return sock.sendMessage(jid, { text: `  ◈ *${feature}* ›› *${action}*` }, { quoted: msg });
        }

        // ── KICK ──────────────────────────────────────────────────────────────
        if (cmd === '.kick' || cmd === '.ban') {
            if (!mentioned) return sock.sendMessage(jid, { text: '  ◈ _tag or mention a user to kick._' }, { quoted: msg });
            await deleteQuotedTargetMessage(sock, msg, jid).catch(() => {});
            await sock.sendMessage(jid, { text: `🚫 @${mentioned.split('@')[0]} has been removed.`, mentions: [mentioned] });
            await kickUser(sock, jid, mentioned).catch(() => {});
            return;
        }

        // ── WARN ──────────────────────────────────────────────────────────────
        if (cmd === '.warn') {
            if (!mentioned) return sock.sendMessage(jid, { text: '  ◈ _tag a user to warn._' }, { quoted: msg });
            const typedTarget = String(args[0] || '').replace(/[^0-9]/g, '');
            const reason = (typedTarget ? args.slice(1) : args).join(' ') || 'No reason given';
            await deleteQuotedTargetMessage(sock, msg, jid).catch(() => {});
            await warnUser(sock, jid, mentioned, reason, group, botId);
            return;
        }

        // ── WARNS ─────────────────────────────────────────────────────────────
        if (cmd === '.warns') {
            if (!mentioned) {
                const list = Object.entries(group.warns || {})
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => `• @${k.split('@')[0]}: ${v}/${group.maxWarns || 3} warns`)
                    .join('\n') || 'No active warns.';
                return sock.sendMessage(jid, { text: `📋 *WARN LIST*\n\n${list}` }, { quoted: msg });
            }
            const count = group.warns?.[mentioned] || 0;
            return sock.sendMessage(jid, {
                text: `  ◈ @${mentioned.split("@")[0]} ›› *${count}/${group.maxWarns || 3} warns*`,
                mentions: [mentioned]
            }, { quoted: msg });
        }

        // ── RESET WARN ────────────────────────────────────────────────────────
        if (cmd === '.resetwarn') {
            if (!mentioned) return sock.sendMessage(jid, { text: '  ◈ _tag a user to reset warns._' }, { quoted: msg });
            group.warns[mentioned] = 0;
            await saveDb(botId);
            return sock.sendMessage(jid, { text: `  ◈ *Warns cleared* ›› @${mentioned.split("@")[0]}`, mentions: [mentioned] }, { quoted: msg });
        }

        // ── DELETE ────────────────────────────────────────────────────────────
        if (cmd === '.delete' || cmd === '.dlt') {
            const quotedKey = buildQuotedDeleteKey(msg, jid);
            if (!quotedKey) return sock.sendMessage(jid, { text: '  ◎ _reply to a message to delete it._' }, { quoted: msg });
            await sock.sendMessage(jid, { delete: quotedKey }).catch(() => {});
            return;
        }

        // ── DELETE ALL (delete all msgs from a tagged user) ───────────────────
        if (cmd === '.deleteall') {
            if (!mentioned) return sock.sendMessage(jid, { text: '  ◈ _tag a user to delete all their messages._' }, { quoted: msg });

            const targetNorm = normalizeJid(mentioned);
            const targetDigits = targetNorm.replace(/[^0-9]/g, '');
            const isTargetBot = targetDigits === String(botId || '').replace(/[^0-9]/g, '');

            // WA may give us the tagged user as a LID or a phone-number JID, and these
            // don't share digits. Try to resolve the counterpart form too (if the
            // Baileys fork exposes LID<->PN lookups) so we can match messages indexed
            // under either form.
            const targetDigitForms = new Set([targetDigits].filter(Boolean));
            try {
                if (typeof sock.getPNById === 'function') {
                    const pn = await sock.getPNById(mentioned).catch(() => null);
                    const d = String(pn || '').replace(/[^0-9]/g, '');
                    if (d) targetDigitForms.add(d);
                }
                if (typeof sock.getLIDById === 'function') {
                    const lid = await sock.getLIDById(mentioned).catch(() => null);
                    const d = String(lid || '').replace(/[^0-9]/g, '');
                    if (d) targetDigitForms.add(d);
                }
            } catch {}

            const statusMsg = await sock.sendMessage(jid, {
                text: `  ◎ _purging messages from @${mentioned.split("@")[0]}..._`,
                mentions: [mentioned]
            });

            const toDelete = [];

            // Fast path: use sender index if available — check every known digit form
            for (const digits of targetDigitForms) {
                const indexedIds = global._senderMsgIndex?.get(`${jid}:${digits}`);
                if (!indexedIds?.size) continue;
                for (const id of indexedIds) {
                    if (toDelete.some(t => t.id === id)) continue;
                    const cachedMsg = global.messageCache?.get(id);
                    if (cachedMsg?.key) toDelete.push({ id, key: cachedMsg.key });
                }
            }

            // Fallback: full scan for any messages not in index (e.g. fromMe bot messages)
            if (global.messageCache) {
                for (const [id, cachedMsg] of global.messageCache.entries()) {
                    if (cachedMsg.key?.remoteJid !== jid) continue;
                    if (toDelete.some(t => t.id === id)) continue; // already found via index
                    let matches;
                    if (cachedMsg.key?.fromMe) {
                        matches = isTargetBot;
                    } else {
                        // Check BOTH the participant and participantPn forms against
                        // every known target digit form.
                        const d1 = String(cachedMsg.key?.participant || '').replace(/[^0-9]/g, '');
                        const d2 = String(cachedMsg.key?.participantPn || '').replace(/[^0-9]/g, '');
                        matches = (d1 && targetDigitForms.has(d1)) || (d2 && targetDigitForms.has(d2));
                    }
                    if (matches) toDelete.push({ id, key: cachedMsg.key });
                }
            }

            if (!toDelete.length) {
                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
                return sock.sendMessage(jid, {
                    text: `📭 No cached messages found from @${mentioned.split('@')[0]}.\n_Note: only messages received since the bot last started are deletable._`,
                    mentions: [mentioned]
                }, { quoted: msg });
            }

            // Batch delete ALL simultaneously for max speed
            const deleteResults = await Promise.allSettled(
                toDelete.map(({ id, key }) =>
                    sock.sendMessage(jid, { delete: key })
                        .then(() => { global.messageCache?.delete(id); return true; })
                        .catch(() => false)
                )
            );
            const deleted = deleteResults.filter(r => r.status === 'fulfilled' && r.value).length;

            // Clean up the per-sender index for every digit form we matched.
            // (Previously referenced an undefined `indexKey`, which threw AFTER deleting and
            //  swallowed the success confirmation — making .deleteall look like it did nothing.)
            for (const digits of targetDigitForms) {
                global._senderMsgIndex?.delete(`${jid}:${digits}`);
            }

            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(jid, {
                text: `✅ Wiped *${deleted}* message(s) from @${mentioned.split('@')[0]}.`,
                mentions: [mentioned]
            }, { quoted: msg });
        }

        // ── PROMOTE / DEMOTE ──────────────────────────────────────────────────
        if (cmd === '.promote') {
            if (!mentioned) return sock.sendMessage(jid, { text: '  ◈ _tag a user to promote._' }, { quoted: msg });
            await sock.groupParticipantsUpdate(jid, [mentioned], 'promote');
            return sock.sendMessage(jid, { text: `  ◈ *Promoted* ›› @${mentioned.split("@")[0]}`, mentions: [mentioned] }, { quoted: msg });
        }

        if (cmd === '.demote') {
            if (!mentioned) return sock.sendMessage(jid, { text: '  ◈ _tag a user to demote._' }, { quoted: msg });
            await sock.groupParticipantsUpdate(jid, [mentioned], 'demote');
            return sock.sendMessage(jid, { text: `  ◈ *Demoted* ›› @${mentioned.split("@")[0]}`, mentions: [mentioned] }, { quoted: msg });
        }

        // ── MUTE / UNMUTE ─────────────────────────────────────────────────────
        if (cmd === '.mute') {
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'announcement' });
            if (!gate.ok) {
                const waitSec = Math.max(1, Math.ceil(Number(gate.waitMs || 0) / 1000));
                return sock.sendMessage(jid, { text: gate.reason === 'cooldown' ? `  ⟡ _metadata cooldown — retry in ${waitSec}s._` : '  ⌬ _metadata guard blocked this action._' }, { quoted: msg });
            }
            await sock.groupSettingUpdate(jid, 'announcement');
            return sock.sendMessage(jid, { text: '  ◉ *Group* ›› *MUTED*  — only admins can send.' }, { quoted: msg });
        }

        if (cmd === '.unmute') {
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'announcement' });
            if (!gate.ok) {
                const waitSec = Math.max(1, Math.ceil(Number(gate.waitMs || 0) / 1000));
                return sock.sendMessage(jid, { text: gate.reason === 'cooldown' ? `  ⟡ _metadata cooldown — retry in ${waitSec}s._` : '  ⌬ _metadata guard blocked this action._' }, { quoted: msg });
            }
            await sock.groupSettingUpdate(jid, 'not_announcement');
            return sock.sendMessage(jid, { text: '  ◉ *Group* ›› *UNMUTED*  — everyone can send.' }, { quoted: msg });
        }

        // ── UNBAN ─────────────────────────────────────────────────────────────
        if (cmd === '.unban') {
            if (!mentioned) return sock.sendMessage(jid, { text: '  ◈ _tag a user to unban/add back._' }, { quoted: msg });
            await sock.groupParticipantsUpdate(jid, [mentioned], 'add');
            return sock.sendMessage(jid, { text: `  ◈ *Added back* ›› @${mentioned.split("@")[0]}`, mentions: [mentioned] }, { quoted: msg });
        }

        // ── STOPREQUEST ───────────────────────────────────────────────────────
        if (cmd === '.stoprequest') {
            if (!global._reqStop) global._reqStop = new Set();
            global._reqStop.add(jid);
            return sock.sendMessage(jid, { text: '  ⌬ _batch halted — current run will finish then stop._' }, { quoted: msg });
        }

        // ── SMART ACCEPT BATCH HELPER ─────────────────────────────────────────
        async function smartAcceptBatch(groupJid, targets) {
            const GC_MAX = 1024;
            const BATCH = 20;
            if (!global._reqStop) global._reqStop = new Set();
            global._reqStop.delete(groupJid);

            // Fetch initial count with timeout guard
            let currentCount = 0;
            try {
                const meta = await Promise.race([
                    sock.groupMetadata(groupJid),
                    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
                ]);
                currentCount = meta?.participants?.length || 0;
            } catch {}

            let slots = GC_MAX - currentCount;
            if (slots <= 0) return { done: 0, stopped: false, full: true };

            const capped = targets.slice(0, slots);
            let done = 0;
            let full = false;

            for (let i = 0; i < capped.length; i += BATCH) {
                if (global._reqStop.has(groupJid)) break;

                const batch = capped.slice(i, i + BATCH);

                // Run the WA call off the event loop tick so other messages still process
                await new Promise(resolve => setImmediate(async () => {
                    try {
                        await sock.groupRequestParticipantsUpdate(groupJid, batch, 'approve');
                    } catch {}
                    done += batch.length;
                    resolve();
                }));

                // Re-check live count every 2 batches (every 40 accepts) to reduce API calls
                if (i % (BATCH * 2) === 0 && i > 0) {
                    try {
                        const fresh = await Promise.race([
                            sock.groupMetadata(groupJid),
                            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
                        ]);
                        currentCount = fresh?.participants?.length || currentCount;
                        slots = GC_MAX - currentCount;
                        if (slots <= 0) { full = true; break; }
                    } catch {}
                }

                // Yield to event loop between batches
                await new Promise(r => setTimeout(r, 2000));
            }

            return { done, stopped: global._reqStop.has(groupJid), full };
        }

        // ── ACCEPT (specific user OR country code filter) ─────────────────────
        // .accept @user          → accept that specific user's request
        // .accept 234            → accept only requests from country code 234
        if (cmd === '.accept') {
            const filter = String(args[0] || '').replace(/[^0-9]/g, '');
            const isCcFilter = filter && filter.length <= 4 && !mentioned;

            if (!isCcFilter && !mentioned) {
                return sock.sendMessage(jid, {
                    text: '❌ Usage:\n• `.accept @user` — accept specific request\n• `.accept 234` — accept all requests from country code 234'
                }, { quoted: msg });
            }

            if (!isCcFilter) {
                // Single user — still check capacity first
                try {
                    const meta = await sock.groupMetadata(jid).catch(() => null);
                    if (meta && meta.participants.length >= 1024) {
                        return sock.sendMessage(jid, { text: '  ⌬ _group is full (1024/1024)._' }, { quoted: msg });
                    }
                    await sock.groupRequestParticipantsUpdate(jid, [mentioned], 'approve');
                    return sock.sendMessage(jid, { text: `  ◈ *Accepted* ›› @${mentioned.split("@")[0]}`, mentions: [mentioned] }, { quoted: msg });
                } catch (e) {
                    return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
                }
            }

            // Country code filter accept
            let pending;
            try { pending = await sock.groupRequestParticipantsList(jid); } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _could not fetch requests: ${e.message}_` }, { quoted: msg });
            }
            const targets = (pending || []).filter(p => String(p.jid || '').replace(/[^0-9]/g, '').startsWith(filter)).map(p => p.jid).slice(0, 5000);
            if (!targets.length) return sock.sendMessage(jid, { text: `📭 No pending requests from country code *${filter}*.` }, { quoted: msg });

            const meta = await sock.groupMetadata(jid).catch(() => null);
            const slots = 1024 - (meta?.participants?.length || 0);
            if (slots <= 0) return sock.sendMessage(jid, { text: '  ⌬ _group is full (1024/1024)._' }, { quoted: msg });

            const statusMsg = await sock.sendMessage(jid, {
                text: `⏳ Accepting requests from +${filter}...\n👥 Slots available: *${slots}* / 1024`
            }, { quoted: msg });

            const { done, stopped, full } = await smartAcceptBatch(jid, targets);
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});

            const suffix = full ? '\n🚫 Group is now full (1024/1024). Remaining requests left pending.' : stopped ? '\n🛑 Stopped early.' : '';
            return sock.sendMessage(jid, { text: `  ◈ *Accepted* ›› *${done}* from +${filter}${suffix}` }, { quoted: msg });
        }

        // ── REJECT (specific user OR country code filter) ─────────────────────
        // .reject @user          → reject that specific user's request
        // .reject 234            → reject only requests from country code 234
        if (cmd === '.reject') {
            const filter = String(args[0] || '').replace(/[^0-9]/g, '');
            const isCcFilter = filter && filter.length <= 4 && !mentioned;

            if (!isCcFilter && !mentioned) {
                return sock.sendMessage(jid, {
                    text: '❌ Usage:\n• `.reject @user` — reject specific request\n• `.reject 234` — reject all requests from country code 234'
                }, { quoted: msg });
            }

            if (!isCcFilter) {
                try {
                    await sock.groupRequestParticipantsUpdate(jid, [mentioned], 'reject');
                    return sock.sendMessage(jid, { text: `  ◈ *Rejected* ›› @${mentioned.split("@")[0]}`, mentions: [mentioned] }, { quoted: msg });
                } catch (e) {
                    return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
                }
            }

            let pending;
            try { pending = await sock.groupRequestParticipantsList(jid); } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _could not fetch requests: ${e.message}_` }, { quoted: msg });
            }
            const targets = (pending || []).filter(p => String(p.jid || '').replace(/[^0-9]/g, '').startsWith(filter)).map(p => p.jid).slice(0, 5000);
            if (!targets.length) return sock.sendMessage(jid, { text: `📭 No pending requests from country code *${filter}*.` }, { quoted: msg });

            if (!global._reqStop) global._reqStop = new Set();
            global._reqStop.delete(jid);
            const statusMsg = await sock.sendMessage(jid, { text: `  ⟡ _rejecting *${targets.length}* request(s) from +${filter}..._` }, { quoted: msg });
            const BATCH = 20; let done = 0;
            for (let i = 0; i < targets.length; i += BATCH) {
                if (global._reqStop.has(jid)) break;
                await sock.groupRequestParticipantsUpdate(jid, targets.slice(i, i + BATCH), 'reject').catch(() => {});
                done += Math.min(BATCH, targets.length - i);
                if (targets.length > BATCH) await new Promise(r => setTimeout(r, 1500));
            }
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(jid, { text: `  ◈ *Rejected* ›› *${done}* from +${filter}` }, { quoted: msg });
        }

        // ── ACCEPTALL / REJECTALL ─────────────────────────────────────────────
        // .acceptall             → accept ALL pending requests
        // .acceptall 234         → accept ONLY requests from +234
        // .rejectall             → reject ALL pending requests
        // .rejectall 234         → reject ONLY requests from +234
        if (cmd === '.acceptall' || cmd === '.rejectall') {
            const action = cmd === '.acceptall' ? 'approve' : 'reject';
            const ccFilter = String(args[0] || '').replace(/[^0-9]/g, '');
            const hasCcFilter = ccFilter && ccFilter.length <= 4;

            let pending;
            try {
                pending = await sock.groupRequestParticipantsList(jid);
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _could not fetch pending requests: ${e.message}_` }, { quoted: msg });
            }

            if (!pending?.length) return sock.sendMessage(jid, { text: '📭 No pending join requests.' }, { quoted: msg });

            // Filter: if cc given, accept/reject ONLY that country code
            let targets = pending.map(p => p.jid).filter(Boolean);
            if (hasCcFilter) {
                targets = targets.filter(j => String(j).replace(/[^0-9]/g, '').startsWith(ccFilter));
            }
            targets = targets.slice(0, 5000);

            const note = hasCcFilter ? ` from +${ccFilter}` : '';

            if (!targets.length) return sock.sendMessage(jid, {
                text: `📭 No pending requests${hasCcFilter ? ` from +${ccFilter}` : ''}.`
            }, { quoted: msg });

            if (!global._reqStop) global._reqStop = new Set();
            global._reqStop.delete(jid);

            // ACCEPT — capacity-aware
            if (action === 'approve') {
                const meta = await sock.groupMetadata(jid).catch(() => null);
                const currentCount = meta?.participants?.length || 0;
                const slots = 1024 - currentCount;

                if (slots <= 0) return sock.sendMessage(jid, {
                    text: '  ⌬ _group is full (1024/1024)._'
                }, { quoted: msg });

                const willAccept = Math.min(targets.length, slots);
                const statusMsg = await sock.sendMessage(jid, {
                    text: `⏳ Accepting *${willAccept}* request(s)${note}...\n👥 Members: *${currentCount}* / 1024 (${slots} slots free)`
                }, { quoted: msg });

                const { done, stopped, full } = await smartAcceptBatch(jid, targets);
                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});

                const suffix = full ? '\n🚫 Group is now full (1024/1024). Remaining requests left pending.'
                    : stopped ? '\n🛑 Stopped early.' : '';
                return sock.sendMessage(jid, {
                    text: `✅ Accepted *${done}* request(s)${note}.${suffix}`
                }, { quoted: msg });
            }

            // REJECT — no capacity concern
            const statusMsg = await sock.sendMessage(jid, {
                text: `⏳ Rejecting *${targets.length}* request(s)${note}...`
            }, { quoted: msg });

            const BATCH = 20; let done = 0;
            for (let i = 0; i < targets.length; i += BATCH) {
                if (global._reqStop.has(jid)) break;
                await sock.groupRequestParticipantsUpdate(jid, targets.slice(i, i + BATCH), 'reject').catch(() => {});
                done += Math.min(BATCH, targets.length - i);
                if (targets.length > BATCH) await new Promise(r => setTimeout(r, 1500));
            }
            const stopped = global._reqStop.has(jid);
            global._reqStop.delete(jid);
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(jid, {
                text: `${stopped ? '🛑 Stopped early.' : '✅'} *${done}* request(s) rejected${note}.`
            }, { quoted: msg });
        }

        // ── GROUP SETTINGS ────────────────────────────────────────────────────
        if (cmd === '.groupsettings') {
            const g = group;
            return sock.sendMessage(jid, {
                text: `⚙️ *GROUP PROTECTION SETTINGS*\n\n` +
                    `🔗 Antilink: ${g.antilink ? '✅' : '🔴'} [${g.antilinkAction}]\n` +
                    `🤖 Antibot: ${g.antibot ? '✅' : '🔴'} [${g.antibotAction}]\n` +
                    `📢 Anti-GM: ${g.antigm ? '✅' : '🔴'} [${g.antigmAction}]\n` +
                    `💬 Antispam: ${g.antispam ? '✅' : '🔴'} [${g.antispamAction}]\n` +
                    `📡 Antichannel: ${g.antichannel ? '✅' : '🔴'} [${g.antichannelAction}]\n` +
                    `📸 AntiGStatus: ${g.antigstatus ? '✅' : '🔴'} [${g.antigstatusAction || 'kick'}]\n` +
                    `🛡️ AntiDemote: ${g.antidemote ? '✅' : '🔴'} [${String(g.antidemoteMode || 'protected')}]\n` +
                    `⚠️ Max Warns: ${g.maxWarns || 3}\n\n` +
                    `_Use .setaction <feature> <kick|warn|delete> to change actions_`
            }, { quoted: msg });
        }

        // ── SET GROUP PFP (admin) ─────────────────────────────────────────────
        if (cmd === '.setgrppfp') {
            const gate = guardGroupMetadataMutation({ jid, command: cmd, action: 'profile-picture' });
            if (!gate.ok) {
                const waitSec = Math.max(1, Math.ceil(Number(gate.waitMs || 0) / 1000));
                return sock.sendMessage(jid, { text: gate.reason === 'cooldown' ? `  ⟡ _metadata cooldown — retry in ${waitSec}s._` : '  ⌬ _metadata guard blocked this action._' }, { quoted: msg });
            }
            const quotedImg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
                || msg.message?.imageMessage;
            if (!quotedImg) return sock.sendMessage(jid, { text: '  ✧ _reply to or send an image to set as group photo._' }, { quoted: msg });
            try {
                const { downloadMediaMessage } = require('@crysnovax/baileys');
                const imgMsg = msg.message?.imageMessage
                    ? msg
                    : { key: msg.key, message: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage };
                const raw = await downloadMediaMessage(imgMsg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                // Get real dimensions so WA doesn't crop to square
                const sharp = require('sharp');
                const meta = await sharp(raw).metadata();
                const w = Math.min(meta.width || 640, 1280);
                const h = Math.min(meta.height || 640, 1280);
                await sock.updateProfilePicture(jid, raw, { width: w, height: h });
                return sock.sendMessage(jid, { text: '  ✧ *Group photo updated.*' }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── TAG — tag all members in the group ─────────────────────────────────
        if (cmd === '.tag') {
            try {
                const meta = await getCachedGroupMeta(sock, jid);
                const members = meta.participants.map(p => p.id);
                const message = args.join(' ').trim();

                // sticker-triggered: send text as-is, no preview building
                if (msg.message?.extendedTextMessage?.linkPreviewFetchDisabled) {
                    return sock.sendMessage(jid, { text: message || '\ud83d\udce2', mentions: members });
                }

                // Extract preview from CURRENT message (when user types .tag with link and preview loads)
                const currentMessageExtended = msg.message?.extendedTextMessage;
                const currentMessageContextInfo = currentMessageExtended?.contextInfo;
                
                // Extract preview from QUOTED message (when user replies to a message)
                const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedStanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
                
                // Check if current message has a link preview
                const hasCurrentPreview = currentMessageContextInfo?.externalAdReply || currentMessageExtended?.matchedText;
                
                // Priority: Use relayMessage to preserve exact structure
                if (hasCurrentPreview && !message) {
                    const ext = currentMessageExtended;
                    // Cache this preview
                    const currentText = ext?.text || '';
                    if (currentText) {
                        const cacheResult = linkPreviewCache.cacheFromMessage(msg, currentText);
                        if (cacheResult?.cached) {
                            logger.info(`[Tag] Cached preview for: ${cacheResult.url?.slice(0, 60)}`);
                        }
                    }
                    const { generateWAMessageFromContent } = require('@crysnovax/baileys');
                    const builtMsg = generateWAMessageFromContent(jid, {
                        extendedTextMessage: { ...ext, contextInfo: { ...(ext.contextInfo || {}), mentionedJid: members } }
                    }, { userJid: sock.user.id });
                    await sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });
                    return;
                } else if (hasCurrentPreview && message) {
                    const ext = currentMessageExtended;
                    // Cache this preview
                    const currentText = ext?.text || message;
                    if (currentText) {
                        const cacheResult = linkPreviewCache.cacheFromMessage(msg, currentText);
                        if (cacheResult?.cached) {
                            logger.info(`[Tag] Cached preview for: ${cacheResult.url?.slice(0, 60)}`);
                        }
                    }
                    const { generateWAMessageFromContent } = require('@crysnovax/baileys');
                    const builtMsg = generateWAMessageFromContent(jid, {
                        extendedTextMessage: { ...ext, text: message, contextInfo: { ...(ext.contextInfo || {}), mentionedJid: members } }
                    }, { userJid: sock.user.id });
                    await sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });
                    return;
                }

                // Replied to a message with a link preview
                if (quotedMessage?.extendedTextMessage) {
                    const ext = quotedMessage.extendedTextMessage;
                    const sendText = message || ext.text || '📢';
                    const targetUrl = ext.matchedText || ext.canonicalUrl || ext['matched-text'] || '';

                    if (targetUrl) {
                        // Cache quoted preview
                        const quotedMsg = { message: { extendedTextMessage: ext } };
                        const quotedText = ext.text || '';
                        if (quotedText) {
                            const cacheResult = linkPreviewCache.cacheFromMessage(quotedMsg, quotedText);
                            if (cacheResult?.cached) {
                                logger.info(`[Tag] Cached quoted preview for: ${cacheResult.url?.slice(0, 60)}`);
                            }
                        }
                        const { generateWAMessageFromContent } = require('@crysnovax/baileys');
                        const builtMsg = generateWAMessageFromContent(jid, {
                            extendedTextMessage: { ...ext, text: sendText, contextInfo: { ...(ext.contextInfo || {}), mentionedJid: members } }
                        }, { userJid: sock.user.id });
                        await sock.relayMessage(jid, builtMsg.message, { messageId: builtMsg.key.id });
                        return;
                    }
                    return sock.sendMessage(jid, { text: sendText, mentions: members });
                }

                // Replied to any other message — forward with mentions
                if (quotedMessage && quotedStanzaId) {
                    await sock.sendMessage(jid, {
                        forward: { key: { remoteJid: jid, fromMe: false, id: quotedStanzaId }, message: quotedMessage },
                        contextInfo: { mentionedJid: members }
                    });
                    if (message) await sock.sendMessage(jid, { text: message, mentions: members });
                    return;
                }

                // Plain tag with optional message or URL
                const sendText = message || '📢 *Group Announcement*';
                const { buildLinkPreview, extractUrls } = require('../core/linkPreview');
                const urls = extractUrls(sendText);
                if (urls.length) {
                    // Check cache first
                    const cachedEntry = linkPreviewCache.getCachedFromText(sendText);
                    if (cachedEntry) {
                        logger.info('[Tag] Using cached preview');
                        const contextInfo = linkPreviewCache.buildContextInfo(cachedEntry, members);
                        if (contextInfo) {
                            return sock.sendMessage(jid, {
                                text: sendText,
                                mentions: members,
                                contextInfo,
                            });
                        }
                    }
                    
                    // Fallback: build preview if not in cache
                    const preview = await buildLinkPreview(sendText, false).catch(() => null);
                    if (preview?.externalAdReply) {
                        preview.externalAdReply.renderLargerThumbnail = true;
                        return sock.sendMessage(jid, {
                            text: sendText,
                            mentions: members,
                            contextInfo: { ...preview, mentionedJid: members },
                        });
                    }
                }
                return sock.sendMessage(jid, { text: sendText, mentions: members });

            } catch (e) {
                if (e.message.includes('rate-overlimit')) {
                    return sock.sendMessage(jid, { text: '  ⟡ *Rate Limited* — wait 30s before retrying.' });
                }
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` });
            }
        }

        // ── SET BOT ACC PFP (owner only) ──────────────────────────────────────
        if (cmd === '.setmypfp' || cmd === '.setpfp') {
            const quotedImg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
                || msg.message?.imageMessage;
            if (!quotedImg) return sock.sendMessage(jid, { text: '  ✧ _reply to or send an image to set as bot profile photo._' }, { quoted: msg });
            try {
                const { downloadMediaMessage } = require('@crysnovax/baileys');
                const imgMsg = msg.message?.imageMessage
                    ? msg
                    : { key: msg.key, message: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage };
                const raw = await downloadMediaMessage(imgMsg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                // Get real dimensions so WA doesn't crop to square
                const sharp = require('sharp');
                const meta = await sharp(raw).metadata();
                const w = Math.min(meta.width || 640, 1280);
                const h = Math.min(meta.height || 640, 1280);
                const botJid = `${botId}@s.whatsapp.net`;
                await sock.updateProfilePicture(botJid, raw, { width: w, height: h });
                return sock.sendMessage(jid, { text: '  ✧ *Bot profile photo updated.*' }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── SET ACCOUNT DISPLAY NAME (owner only) ────────────────────────────
        if (cmd === '.setname') {
            const newName = args.join(' ').trim();
            if (!newName) return sock.sendMessage(jid, { text: '❌ Usage: .setname <new name>' }, { quoted: msg });
            try {
                await sock.updateProfileName(newName);
                return sock.sendMessage(jid, { text: `✅ Account name updated to: *${newName}*` }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Failed to update name: ${e.message}` }, { quoted: msg });
            }
        }

        // ── DELETE PFP (owner only) ───────────────────────────────────────────
        if (cmd === '.delpfp') {
            try {
                const target = mentioned || `${botId}@s.whatsapp.net`;
                await sock.removeProfilePicture(target);
                return sock.sendMessage(jid, { text: '✅ Profile photo removed.' }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── FULL PFP — fetch full uncropped profile picture ───────────────────
        if (cmd === '.fullpfp') {
            const target = mentioned
                || msg.message?.extendedTextMessage?.contextInfo?.participant
                || msg.key.remoteJid;
            try {
                const ppUrl = await sock.profilePictureUrl(target, 'image');
                const axios = require('axios');
                const res   = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 10000 });
                const buffer = Buffer.from(res.data);
                const name = target.split('@')[0];
                return sock.sendMessage(jid, {
                    image:   buffer,
                    caption: `🖼️ *Full Profile Picture*\n📱 +${name}`,
                }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `❌ Could not fetch profile picture.\n${e.message}` }, { quoted: msg });
            }
        }

        // ── GROUP LINK ────────────────────────────────────────────────────────
        if (cmd === '.grouplink') {
            if (!isGroup) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            try {
                const code = await sock.groupInviteCode(jid);
                return sock.sendMessage(jid, {
                    text: [
                        `꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦`,
                        `  ✿ *Group Invite Link*`,
                        `꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦`,
                        ``,
                        `  🔗 https://chat.whatsapp.com/${code}`,
                    ].join('\n')
                }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── REVOKE GROUP LINK ─────────────────────────────────────────────────
        if (cmd === '.revoke') {
            if (!isGroup) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            try {
                await sock.groupRevokeInvite(jid);
                const newCode = await sock.groupInviteCode(jid);
                return sock.sendMessage(jid, {
                    text: [
                        `  ✅ *Invite link revoked & renewed.*`,
                        `  🔗 New: https://chat.whatsapp.com/${newCode}`,
                    ].join('\n')
                }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── HIDETAG — mention all members silently ────────────────────────────
        if (cmd === '.hidetag') {
            if (!isGroup) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            try {
                const meta    = await getCachedGroupMeta(sock, jid);
                const members = meta.participants.map(p => p.id);
                const text    = args.join(' ').trim() || '‎'; // zero-width char so msg isn't empty
                return sock.sendMessage(jid, { text, mentions: members });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── CLEAR ALL WARNS ───────────────────────────────────────────────────
        if (cmd === '.clearwarns') {
            if (!isGroup) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            const gs = getGroupSettings(jid);
            if (!gs.warns) gs.warns = {};
            const count = Object.keys(gs.warns).length;
            gs.warns = {};
            saveGroupSettings(jid, gs);
            return sock.sendMessage(jid, {
                text: `  ✅ *Cleared warns* for *${count}* member(s) in this group.`
            }, { quoted: msg });
        }

        // ── MEMBER LIST ───────────────────────────────────────────────────────
        if (cmd === '.memberlist') {
            if (!isGroup) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            try {
                const meta    = await getCachedGroupMeta(sock, jid);
                const admins  = meta.participants.filter(p => p.admin).map(p => p.id);
                const members = meta.participants.map(p => p.id);
                const lines   = [`꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦`, `  ✿ *Members (${members.length})*`, `꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦`, ``];
                for (const m of members) {
                    const num  = m.split('@')[0];
                    const role = admins.includes(m) ? ' 👑' : '';
                    lines.push(`  • +${num}${role}`);
                }
                return sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── DISAPPEARING MESSAGES ─────────────────────────────────────────────
        if (cmd === '.disappear') {
            if (!isGroup) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
            const sub = (args[0] || '').toLowerCase();
            const options = {
                'off': 0,
                '24h': 86400,
                '7d': 604800,
                '90d': 7776000,
            };
            if (!options.hasOwnProperty(sub)) {
                return sock.sendMessage(jid, {
                    text: [
                        `  ✿ *Disappearing Messages*`,
                        ``,
                        `  Usage: \`.disappear <duration>\``,
                        `  Options: \`off\` · \`24h\` · \`7d\` · \`90d\``,
                    ].join('\n')
                }, { quoted: msg });
            }
            try {
                await sock.sendMessage(jid, { disappearingMessagesInChat: options[sub] });
                const label = sub === 'off' ? 'disabled' : `set to *${sub}*`;
                return sock.sendMessage(jid, { text: `  ✅ Disappearing messages ${label}.` }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── EDIT MESSAGE (Baileys trick — no "edited" tag) ────────────────────
        if (cmd === '.edit') {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const quotedKey = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            const newText = args.join(' ').trim();
            if (!quoted || !quotedKey || !newText) {
                return sock.sendMessage(jid, {
                    text: `  ✿ *Edit a message*\n\n  Reply to a message and use:\n  \`.edit <new text>\``
                }, { quoted: msg });
            }
            try {
                const targetJid = msg.message?.extendedTextMessage?.contextInfo?.participant || jid;
                await sock.sendMessage(jid, {
                    text: newText,
                    edit: {
                        remoteJid: jid,
                        fromMe:    targetJid === (botId + '@s.whatsapp.net'),
                        id:        quotedKey,
                    },
                });
                // Delete the .edit command to keep chat clean
                await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }

        // ── GHOST MODE (read receipts toggle) ─────────────────────────────────
        if (cmd === '.ghostmode') {
            const sub = (args[0] || '').toLowerCase();
            if (!sub || (sub !== 'on' && sub !== 'off')) {
                return sock.sendMessage(jid, { text: `  ✿ Usage: \`.ghostmode on\` or \`.ghostmode off\`` }, { quoted: msg });
            }
            try {
                await sock.updateReadReceiptsPrivacy(sub === 'on' ? 'none' : 'all');
                return sock.sendMessage(jid, {
                    text: `  ✅ Ghost mode *${sub}*. Read receipts ${sub === 'on' ? 'hidden' : 'visible'}.`
                }, { quoted: msg });
            } catch (e) {
                return sock.sendMessage(jid, { text: `  ⌬ _failed: ${e.message}_` }, { quoted: msg });
            }
        }
    }
};
