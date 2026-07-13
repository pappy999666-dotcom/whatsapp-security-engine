'use strict';
// plugins/pappy-security.js — Fortress-Level Security Middleware commands
//
// Deliberately namespaced under "fortress*" so these NEVER collide with the
// existing, working .antilink/.antibot/.antispam toggles in pappy-admin.js.
// This plugin only exposes configuration for the new deep-inspection /
// device-identity / smart-velocity engine wired in core/security/securityPipeline.js.

const securityConfig = require('../core/security/securityConfig');

function resolveTargetJid(msg, args = []) {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (mentioned) return mentioned;
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (quoted) return quoted;
    const numeric = String(args[0] || '').replace(/[^0-9]/g, '');
    if (numeric.length >= 7) return `${numeric}@s.whatsapp.net`;
    return null;
}

const VALID_ACTIONS = new Set(['kick', 'warn', 'delete', 'delete_warn']);

module.exports = {
    category: 'SECURITY',
    commands: [
        { cmd: '.fortress',      role: 'admin' },
        { cmd: '.fortresslink',  role: 'admin' },
        { cmd: '.fortressbot',   role: 'admin' },
        { cmd: '.fortressspam',  role: 'admin' },
        { cmd: '.securitymsg',   role: 'admin' },
        { cmd: '.securitytoggle', role: 'admin' },
    ],

    execute: async ({ sock, msg, args, text, botId }) => {
        const jid = msg.key.remoteJid;
        const cmd = text.split(' ')[0].toLowerCase();
        if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: '  ⌬ _groups only._' }, { quoted: msg });
        const cfg = securityConfig.getConfig(jid, botId);

        // ── STATUS TABLE ───────────────────────────────────────────────────────
        if (cmd === '.fortress') {
            return sock.sendMessage(jid, {
                title: '🏰 FORTRESS SECURITY',
                headerText: '## Deep-Inspection Engine',
                contentText: '---',
                table: [
                    ['Feature', 'Status', 'Action'],
                    ['Deep AntiLink', cfg.fortressLinkEnabled ? '✅ ON' : '🔴 OFF', cfg.fortressLinkAction],
                    ['Deep AntiBot',  cfg.fortressBotEnabled  ? '✅ ON' : '🔴 OFF', cfg.fortressBotAction],
                    ['Smart AntiSpam', cfg.fortressSpamEnabled ? `✅ ON (${cfg.fortressSpamSeconds}s)` : '🔴 OFF', cfg.fortressSpamAction],
                    ['Action Messages', cfg.actionToggle ? '✅ ON' : '🔇 LOG ONLY', '—'],
                ],
                noHeading: false,
                footerText: 'Use .fortresslink / .fortressbot / .fortressspam / .securitytoggle to configure',
            }, { quoted: msg });
        }

        // ── DEEP ANTILINK ──────────────────────────────────────────────────────
        if (cmd === '.fortresslink') {
            const arg = String(args[0] || '').toLowerCase();
            if (arg === 'on' || arg === 'off') {
                const action = VALID_ACTIONS.has(String(args[1] || '').toLowerCase()) ? args[1].toLowerCase() : cfg.fortressLinkAction;
                securityConfig.setConfig(jid, botId, { fortressLinkEnabled: arg === 'on', fortressLinkAction: action });
                return sock.sendMessage(jid, { text: `${arg === 'on' ? '✅' : '🔴'} *Deep AntiLink* is now *${arg.toUpperCase()}* (action: ${action}).\nCovers text, poll options, list rows, and view-once wrappers — plus hidden/obfuscated links.` }, { quoted: msg });
            }
            return sock.sendMessage(jid, { text: `⚙️ *Deep AntiLink*: ${cfg.fortressLinkEnabled ? '✅ ON' : '🔴 OFF'} (${cfg.fortressLinkAction})\n\nUsage: .fortresslink on|off [kick|warn|delete|delete_warn]` }, { quoted: msg });
        }

        // ── DEEP ANTIBOT ────────────────────────────────────────────────────────
        if (cmd === '.fortressbot') {
            const arg = String(args[0] || '').toLowerCase();
            if (arg === 'on' || arg === 'off') {
                const action = VALID_ACTIONS.has(String(args[1] || '').toLowerCase()) ? args[1].toLowerCase() : cfg.fortressBotAction;
                securityConfig.setConfig(jid, botId, { fortressBotEnabled: arg === 'on', fortressBotAction: action });
                return sock.sendMessage(jid, { text: `${arg === 'on' ? '✅' : '🔴'} *Deep AntiBot* is now *${arg.toUpperCase()}* (action: ${action}).\nFlags web/desktop clients with no prior presence, and composing events from JIDs with zero message history.` }, { quoted: msg });
            }
            return sock.sendMessage(jid, { text: `⚙️ *Deep AntiBot*: ${cfg.fortressBotEnabled ? '✅ ON' : '🔴 OFF'} (${cfg.fortressBotAction})\n\nUsage: .fortressbot on|off [kick|warn|delete]` }, { quoted: msg });
        }

        // ── SMART ANTISPAM ───────────────────────────────────────────────────────
        if (cmd === '.fortressspam') {
            const arg = String(args[0] || '').toLowerCase();
            if (arg === 'off') {
                securityConfig.setConfig(jid, botId, { fortressSpamEnabled: false });
                return sock.sendMessage(jid, { text: '🔴 *Smart AntiSpam* is now *OFF*.' }, { quoted: msg });
            }
            const seconds = parseInt(arg, 10);
            if (seconds && seconds >= 1 && seconds <= 60) {
                const action = VALID_ACTIONS.has(String(args[1] || '').toLowerCase()) ? args[1].toLowerCase() : cfg.fortressSpamAction;
                securityConfig.setConfig(jid, botId, { fortressSpamEnabled: true, fortressSpamSeconds: seconds, fortressSpamAction: action });
                return sock.sendMessage(jid, { text: `✅ *Smart AntiSpam* is now *ON* — ${seconds}s window, action: ${action}.\nOnly triggers for clients already flagged as bots by Deep AntiBot.` }, { quoted: msg });
            }
            return sock.sendMessage(jid, { text: `⚙️ *Smart AntiSpam*: ${cfg.fortressSpamEnabled ? `✅ ON (${cfg.fortressSpamSeconds}s)` : '🔴 OFF'} (${cfg.fortressSpamAction})\n\nUsage: .fortressspam <1-60> [kick|warn|delete] | .fortressspam off\n\nNote: requires .fortressbot on to identify bot clients.` }, { quoted: msg });
        }

        // ── GLOBAL ACTION-MESSAGE TOGGLE ────────────────────────────────────────
        if (cmd === '.securitytoggle') {
            const arg = String(args[0] || '').toLowerCase();
            if (arg === 'on' || arg === 'off') {
                securityConfig.setConfig(jid, botId, { actionToggle: arg === 'on' });
                return sock.sendMessage(jid, { text: arg === 'on' ? '✅ *Action messages* enabled — violations will post a message.' : '🔇 *Log-only mode* — violations are still actioned (kick/warn/delete) but no message is sent.' }, { quoted: msg });
            }
            return sock.sendMessage(jid, { text: `⚙️ Action messages: ${cfg.actionToggle ? '✅ ON' : '🔇 LOG ONLY'}\n\nUsage: .securitytoggle on|off` }, { quoted: msg });
        }

        // ── CUSTOM MESSAGE TEMPLATES ──────────────────────────────────────────
        if (cmd === '.securitymsg') {
            const type = String(args[0] || '').toLowerCase();
            if (!['link', 'bot', 'spam'].includes(type)) {
                return sock.sendMessage(jid, {
                    text: '  ◈ *Usage:* `.securitymsg <link|bot|spam> <template>`\n\nTokens: $desc $pp $gcname $size $rsn $count $mention &num\n\nCurrent templates:\n' +
                        `• link: ${cfg.messages.link}\n• bot: ${cfg.messages.bot}\n• spam: ${cfg.messages.spam}`
                }, { quoted: msg });
            }
            const template = args.slice(1).join(' ').trim();
            if (!template) return sock.sendMessage(jid, { text: `  ◈ Current *${type}* template:\n${cfg.messages[type]}` }, { quoted: msg });
            securityConfig.setMessageTemplate(jid, botId, type, template);
            return sock.sendMessage(jid, { text: `  ✅ *${type}* message template updated.` }, { quoted: msg });
        }
    },
};
