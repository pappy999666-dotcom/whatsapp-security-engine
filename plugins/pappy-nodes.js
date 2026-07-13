'use strict';
// plugins/pappy-nodes.js
// ─── NODE MANAGEMENT & CROSS-NODE RELAY (global owner only) ──────────────────
//
// WhatsApp side had no way to see other paired nodes or reach across them.
// `.sudo`/`.delsudo` are per-node (see pappy-core.js) and stay isolated by design.
// The ONLY sanctioned way to cross a node boundary is `.relay`, gated strictly to
// the fixed global owner (config.ownerWhatsAppJids) — never to a per-node
// owner/sudo, even one paired under the same Telegram account. This preserves
// strict node isolation: no node can reach or control another node on its own.

const path = require('path');
const config = require('../config');
const waSocketRegistry = require('../modules/waSocketRegistry');
const eventBus = require('../core/eventBus');
const logger = require('../core/logger');

function isGlobalOwnerFromConfig(jid) {
    const ownerSet = new Set((config.ownerWhatsAppJids || []).map(j => String(j || '').trim()).filter(Boolean));
    const ownerDigits = new Set(Array.from(ownerSet).map(j => j.replace(/[^0-9]/g, '')).filter(Boolean));
    const norm = String(jid || '').replace(/:\d+(?=@)/g, '').trim();
    const digits = norm.replace(/[^0-9]/g, '');
    return ownerSet.has(jid) || ownerSet.has(norm) || ownerDigits.has(digits);
}

function listNodes() {
    const all = waSocketRegistry.getAll();
    const byBotId = new Map(); // dedupe multiple session keys pointing at the same bot
    for (const [sessionKey, sock] of all.entries()) {
        const botDigits = String(sock?.user?.id || '').split(':')[0].replace(/[^0-9]/g, '');
        if (!botDigits) continue;
        byBotId.set(botDigits, { sessionKey, sock });
    }
    return byBotId;
}

module.exports = {
    category: 'CORE',
    commands: [
        { cmd: '.nodes',    role: 'owner' },
        { cmd: '.nodeinfo', role: 'owner' },
        { cmd: '.relay',    role: 'owner' },
    ],

    execute: async ({ sock, msg, args, botId }) => {
        const jid = msg.key.remoteJid;
        const cmd = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().split(' ')[0].toLowerCase();
        const sender = msg.key.participant || msg.key.remoteJid;

        // ── NODES — list every currently connected WhatsApp session ────────────
        if (cmd === '.nodes') {
            if (!isGlobalOwnerFromConfig(sender)) return sock.sendMessage(jid, { text: `  ❖ _global owner only._` }, { quoted: msg });
            const nodes = listNodes();
            if (!nodes.size) return sock.sendMessage(jid, { text: `  ⟡ _no nodes currently connected._` }, { quoted: msg });
            const lines = Array.from(nodes.entries()).map(([digits, { sock: s }], i) => {
                const mode = (() => {
                    try { return require('../core/whatsapp').getNodeMode(digits); } catch { return 'unknown'; }
                })();
                const marker = digits === String(botId || '').replace(/[^0-9]/g, '') ? ' (this node)' : '';
                return `  ${i + 1}. +${digits}${marker} — ${mode}`;
            });
            return sock.sendMessage(jid, {
                text: [
                    `╭──────────────────────────╮`,
                    `│   ⬡  A C T I V E  N O D E S   │`,
                    `╰──────────────────────────╯`,
                    ``,
                    ...lines,
                    ``,
                    `  ✦ _.nodeinfo <digits>_ — stats for a node`,
                    `  ✦ _.relay <digits> <command>_ — run a command on another node`,
                ].join('\n')
            }, { quoted: msg });
        }

        // ── NODEINFO — stats for the current node or a specified one ────────────
        if (cmd === '.nodeinfo') {
            if (!isGlobalOwnerFromConfig(sender)) return sock.sendMessage(jid, { text: `  ❖ _global owner only._` }, { quoted: msg });
            const targetDigits = (args[0]?.replace(/[^0-9]/g, '')) || String(botId || '').replace(/[^0-9]/g, '');
            if (!targetDigits) return sock.sendMessage(jid, { text: `  ◈ *Usage:* \`.nodeinfo [digits]\`` }, { quoted: msg });
            const targetSock = waSocketRegistry.getByBotId(targetDigits);
            if (!targetSock) return sock.sendMessage(jid, { text: `  ⟡ _node +${targetDigits} is not connected._` }, { quoted: msg });

            let mode = 'unknown';
            try { mode = require('../core/whatsapp').getNodeMode(targetDigits); } catch {}
            let sudoCount = 0;
            try { sudoCount = require('../modules/permissionEngine').getNodeSudos(targetDigits).length; } catch {}

            return sock.sendMessage(jid, {
                text: [
                    `╭──────────────────────────╮`,
                    `│   ⬡  N O D E  I N F O   │`,
                    `╰──────────────────────────╯`,
                    ``,
                    `  ◈ *Node* ›› +${targetDigits}`,
                    `  ◈ *Mode* ›› ${mode}`,
                    `  ◈ *Push name* ›› ${targetSock.user?.name || 'n/a'}`,
                    `  ◈ *Node sudo count* ›› ${sudoCount}`,
                ].join('\n')
            }, { quoted: msg });
        }

        // ── RELAY — global owner only, run a command on another node ───────────
        // Reuses the exact same message.upsert pipeline every real WhatsApp message
        // goes through (permission checks included), so relayed commands are held to
        // identical rules as if sent directly on the target node. No node ever
        // triggers this itself — it is only reachable by the fixed global owner.
        if (cmd === '.relay') {
            if (!isGlobalOwnerFromConfig(sender)) return sock.sendMessage(jid, { text: `  ❖ _global owner only. Per-node sudo cannot relay._` }, { quoted: msg });
            const targetDigits = args[0]?.replace(/[^0-9]/g, '');
            const relayCommand = args.slice(1).join(' ').trim();
            if (!targetDigits || !relayCommand) {
                return sock.sendMessage(jid, { text: `  ◈ *Usage:* \`.relay <nodeDigits> <command>\`` }, { quoted: msg });
            }
            const targetSock = waSocketRegistry.getByBotId(targetDigits);
            if (!targetSock) return sock.sendMessage(jid, { text: `  ⟡ _node +${targetDigits} is not connected._` }, { quoted: msg });

            const normalizedCmd = relayCommand.startsWith(config.globalPrefix) ? relayCommand : `${config.globalPrefix}${relayCommand}`;
            const ownerJid = sender;
            const syntheticId = `RELAY-${Date.now()}`;

            eventBus.emit('message.upsert', {
                sock: targetSock,
                msg: {
                    key: { remoteJid: ownerJid, fromMe: true, id: syntheticId },
                    message: { conversation: normalizedCmd },
                    pushName: 'Owner (relay)',
                },
                text: normalizedCmd,
                isGroup: false,
                sender: ownerJid,
                botId: targetDigits,
                isGroupAdmin: false,
                botIsGroupAdmin: false,
            });

            logger.info(`[Relay] ${sender} relayed "${normalizedCmd}" from node ${botId} to node ${targetDigits}`);
            return sock.sendMessage(jid, {
                text: `  ◈ *Relayed* \`${normalizedCmd}\` ›› node +${targetDigits}\n  ✦ _reply will arrive from that node's own number._`
            }, { quoted: msg });
        }
    }
};
