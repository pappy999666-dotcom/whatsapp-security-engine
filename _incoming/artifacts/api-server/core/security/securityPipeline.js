'use strict';
// core/security/securityPipeline.js
// ─── FORTRESS-LEVEL SECURITY MIDDLEWARE ────────────────────────────────────────
//
// SecurityMiddleware  — entry point; attaches to a socket's message.upsert /
//                        presence.update / group-participants.update events.
// FilterPipeline      — runs checks in strict order: Presence -> Identity ->
//                        Link -> Spam -> Poll (poll/list link matches surface
//                        through the same deep-link scanner as "Link", labeled
//                        separately in the result so the reason string is clear
//                        about which structure the link was hidden in).
// DispatchAction       — executes kick/warn/delete, honors the global
//                        actionToggle (log-only mode), and renders messages
//                        through the variable-injection engine.
//
// This sits alongside (not instead of) the existing 31-check antiEngine
// pipeline — it targets the specific gaps that pipeline's checkAntiLink/
// checkAntiPoll do not cover (recursive protobuf inspection, device/presence-
// based bot identity, and IsBotClient-gated velocity spam), namespaced under
// "fortress*" settings so it can never collide with the working .antilink/
// .antibot/.antispam toggles.

const logger = require('../logger');
const eventBus = require('../eventBus');
const permissionEngine = require('../../modules/permissionEngine');
const securityConfig = require('./securityConfig');
const deepLinkScan = require('./deepLinkScan');
const deviceIdentity = require('./deviceIdentity');
const { renderTemplate } = require('./variableInjector');

// Velocity tracking for the smart antispam engine: Map<`${botId}:${jid}`, lastMessageTime>
const _lastMessageTime = new Map();

function _velocityKey(botId, jid) {
    return `${String(botId || 'global')}:${String(jid || '')}`;
}

// ─── FilterPipeline ────────────────────────────────────────────────────────────
class FilterPipeline {
    /**
     * run — evaluates the ordered checks for a single incoming group message.
     * @returns {{ triggered: boolean, module?: string, reason?: string, action?: string }}
     */
    async run(ctx, cfg) {
        // 1. PRESENCE / IDENTITY — combined into one classify() call, since both
        //    signals (presence-flag, device+no-presence) feed the same IsBotClient verdict.
        if (cfg.fortressBotEnabled) {
            const identity = deviceIdentity.classify({
                botId: ctx.botId,
                jid: ctx.senderJid,
                msgId: ctx.msgId,
                isFirstMessageFromSender: ctx.isFirstMessageFromSender,
            });
            ctx.isBotClient = identity.isBotClient;
            ctx.device = identity.device;
            if (identity.isBotClient) {
                return { triggered: true, module: 'fortressBot', reason: identity.reason, action: cfg.fortressBotAction };
            }
        }

        // 2. LINK — deep recursive scan across text/poll/list/view-once structures.
        if (cfg.fortressLinkEnabled) {
            const scan = deepLinkScan.scanMessage(ctx.rawMessage);
            if (scan.found) {
                const hit = scan.inviteLinks[0] || scan.matches[0];
                const via = scan.source[0] ? ` (in: "${scan.source[0]}")` : '';
                return { triggered: true, module: 'fortressLink', reason: `Hidden/obfuscated link detected: ${hit}${via}`, action: cfg.fortressLinkAction };
            }
        }

        // 3. SPAM — smart velocity, gated on IsBotClient only (a fast-typing human
        //    is never punished; only clients already flagged as bots are rate-limited).
        if (cfg.fortressSpamEnabled && ctx.isBotClient) {
            const key = _velocityKey(ctx.botId, ctx.senderJid);
            const now = Date.now();
            const last = _lastMessageTime.get(key);
            _lastMessageTime.set(key, now);
            const windowMs = Math.min(60, Math.max(1, Number(cfg.fortressSpamSeconds) || 5)) * 1000;
            if (last && (now - last) < windowMs) {
                return { triggered: true, module: 'fortressSpam', reason: `Bot-client sent 2 messages within ${cfg.fortressSpamSeconds}s`, action: cfg.fortressSpamAction };
            }
        }

        return { triggered: false };
    }
}

// ─── DispatchAction ────────────────────────────────────────────────────────────
class DispatchAction {
    /**
     * run — executes the action decided by FilterPipeline: delete the message,
     * warn (with warn-count tracking + auto-kick past a threshold, mirroring
     * pappy-admin's existing warn semantics), or kick outright. Messages are
     * rendered through the variable-injection engine and are only sent at all
     * if the group's actionToggle is on (otherwise this just logs).
     */
    async run({ sock, ctx, result, cfg, groupJid, botId }) {
        const actions = String(result.action || 'warn').split('_'); // e.g. 'delete_warn' → ['delete','warn']

        if (actions.includes('delete') && ctx.rawMsgKey) {
            sock.sendMessage(groupJid, { delete: ctx.rawMsgKey }).catch(() => {});
        }

        logger.info(`[Fortress] ${result.module} triggered for ${ctx.senderJid} in ${groupJid}: ${result.reason} → action=${result.action}`);

        if (!cfg.actionToggle) return; // log-only mode — no messages sent

        const violationType = result.module === 'fortressLink' ? 'link' : result.module === 'fortressBot' ? 'bot' : 'spam';
        const template = cfg.messages?.[violationType] || `⚠️ $mention — $rsn`;

        const vars = {
            rsn: result.reason,
            mentionJid: ctx.senderJid,
            num: String(ctx.senderJid || '').split('@')[0],
            gcname: ctx.groupMeta?.subject,
            desc: ctx.groupMeta?.desc,
            size: ctx.groupMeta?.participants?.length,
            pp: ctx.senderPp,
        };

        if (actions.includes('kick')) {
            try {
                await sock.groupParticipantsUpdate(groupJid, [ctx.senderJid], 'remove');
            } catch (e) {
                logger.warn(`[Fortress] kick failed for ${ctx.senderJid}: ${e.message}`);
            }
            const { text, mentions } = renderTemplate(template, vars);
            sock.sendMessage(groupJid, { text, mentions }).catch(() => {});
            return;
        }

        if (actions.includes('warn')) {
            const count = securityConfig.bumpWarn(groupJid, botId, ctx.senderJid);
            const maxWarns = 3;
            const { text, mentions } = renderTemplate(template, { ...vars, count });
            sock.sendMessage(groupJid, { text: `${text}\n🔢 Warns: ${count}/${maxWarns}`, mentions }).catch(() => {});
            if (count >= maxWarns) {
                securityConfig.resetWarn(groupJid, botId, ctx.senderJid);
                try { await sock.groupParticipantsUpdate(groupJid, [ctx.senderJid], 'remove'); } catch {}
            }
            return;
        }

        // action === 'delete' only — no extra message needed beyond the delete above,
        // but still surface a lightweight notice for visibility.
        const { text, mentions } = renderTemplate(template, vars);
        sock.sendMessage(groupJid, { text, mentions }).catch(() => {});
    }
}

// ─── SecurityMiddleware ────────────────────────────────────────────────────────
class SecurityMiddleware {
    constructor() {
        this.pipeline = new FilterPipeline();
        this.dispatcher = new DispatchAction();
        this._started = false;
        // Track which JIDs have ever sent a message on a given node, so
        // deviceIdentity.classify can determine "first message ever" (Instant Bot).
        this._seenSenders = new Set(); // `${botId}:${jid}`
    }

    attach() {
        if (this._started) return;
        this._started = true;

        eventBus.on('message.upsert', async (payload) => {
            try { await this._handleMessage(payload); } catch (err) {
                logger.warn(`[Fortress] message handler error: ${err.message}`);
            }
        });

        eventBus.on('presence.update', ({ botId, jid, presences }) => {
            try { deviceIdentity.onPresence(botId, jid, presences); } catch (err) {
                logger.warn(`[Fortress] presence handler error: ${err.message}`);
            }
        });

        logger.info('[Fortress] Security pipeline attached (message.upsert + presence.update)');
    }

    async _handleMessage({ sock, msg, text, isGroup, sender, botId, isGroupAdmin }) {
        if (!isGroup || !msg?.message || msg.key.fromMe || !sock) return;
        const groupJid = msg.key.remoteJid;

        // Owner/sudo are always exempt, matching antiHook's existing exemption.
        if (permissionEngine.can(sender, botId, 'node_sudo')) return;
        if (isGroupAdmin) return;

        const cfg = securityConfig.getConfig(groupJid, botId);
        if (!cfg.fortressLinkEnabled && !cfg.fortressBotEnabled && !cfg.fortressSpamEnabled) return;

        const seenKey = `${botId}:${sender}`;
        const isFirstMessageFromSender = !this._seenSenders.has(seenKey);
        this._seenSenders.add(seenKey);
        deviceIdentity.recordMessage(botId, sender);

        const ctx = {
            botId,
            groupJid,
            senderJid: sender,
            msgId: msg.key.id,
            rawMessage: msg.message,
            rawMsgKey: msg.key,
            text,
            isFirstMessageFromSender,
        };

        const result = await this.pipeline.run(ctx, cfg);
        if (!result.triggered) return;

        await this.dispatcher.run({ sock, ctx, result, cfg, groupJid, botId });
    }
}

let _instance = null;
function init() {
    if (!_instance) _instance = new SecurityMiddleware();
    _instance.attach();
    return _instance;
}

module.exports = { SecurityMiddleware, FilterPipeline, DispatchAction, init };
