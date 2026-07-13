'use strict';
// plugins/pappy-system.js
// System management commands (owner only)

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const path = require('path');

// Load/save sudo users per botId (per-node isolated)
function getSudoFilePath(botId) {
    const digits = String(botId || '').replace(/[^0-9]/g, '') || 'global';
    return path.join(__dirname, `../data/sudo-users-${digits}.json`);
}

function loadSudoUsers(botId) {
    try {
        const filePath = getSudoFilePath(botId);
        if (fs.existsSync(filePath)) {
            return new Set(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        }
    } catch {}
    return new Set();
}

function saveSudoUsers(sudoSet, botId) {
    try {
        const filePath = getSudoFilePath(botId);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify([...sudoSet], null, 2));
    } catch {}
}

function normalizeJid(jid) {
    return String(jid || '').replace(/:\d+@/g, '@').trim();
}

function extractDigits(jid) {
    return normalizeJid(jid).replace(/[^0-9]/g, '');
}

module.exports = {
    category: 'SYSTEM',
    commands: [
        { cmd: '.updatebailey',  role: 'owner' },
        { cmd: '.setsudo',       role: 'owner' },
        { cmd: '.delsudo',       role: 'owner' },
        { cmd: '.listsudo',      role: 'owner' },
        { cmd: '.restart',       role: 'owner' },
        { cmd: '.setgodcasttmp', role: 'owner' },
        { cmd: '.godcasttheme',  role: 'owner' },
    ],

    execute: async ({ sock, msg, args, text, botId }) => {
        const chat = msg.key.remoteJid;
        const cmd = text.split(/\s+/)[0].toLowerCase();

        // ── .updatebailey ─────────────────────────────────────────────────
        if (cmd === '.updatebailey') {
            const version = args[0] || 'latest';
            await sock.sendMessage(chat, {
                text: `⏳ Updating @crysnovax/baileys to ${version}...`
            }, { quoted: msg });

            try {
                const { stdout } = await execPromise(
                    `npm install @crysnovax/baileys@${version} --legacy-peer-deps`,
                    { cwd: process.cwd(), timeout: 120000 }
                );
                const installedVersion = stdout.match(/@crysnovax\/baileys@([\d.]+)/)?.[1] || version;
                await sock.sendMessage(chat, {
                    text: `✅ *Baileys Updated*\n\n📦 Version: ${installedVersion}\n\n⚠️ Run \`.restart\` to apply changes.`
                }, { quoted: msg });
            } catch (error) {
                await sock.sendMessage(chat, {
                    text: `❌ *Update Failed*\n\n${error.message}`
                }, { quoted: msg });
            }
            return;
        }

        // ── .setsudo — PER-NODE ONLY ───────────────────────────────────────
        // Grants owner-level permissions on THIS node only.
        // Use the Telegram panel (/sudo add) to add Global Owners.
        if (cmd === '.setsudo') {
            const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                              msg.message?.extendedTextMessage?.contextInfo?.participant;

            if (!targetJid) {
                return sock.sendMessage(chat, {
                    text: '❌ Tag a user to grant node sudo access.\n\n_Example: .setsudo @user_\n\n_Note: For Global Owner access across all nodes, use the Telegram panel (/sudo add)._'
                }, { quoted: msg });
            }

            const sudoUsers = loadSudoUsers(botId);
            const normalized = normalizeJid(targetJid);
            const digits = extractDigits(targetJid);

            sudoUsers.add(normalized);
            if (digits) sudoUsers.add(digits);
            saveSudoUsers(sudoUsers, botId);

            return sock.sendMessage(chat, {
                text: `✅ *Node Sudo Granted*\n\n👤 @${targetJid.split('@')[0]}\n🤖 Node: ${botId}\n\n⚠️ This user now has owner-level access on *this node only*.\nTo grant access across all nodes, use the Telegram panel.`,
                mentions: [targetJid]
            }, { quoted: msg });
        }

        // ── .delsudo ──────────────────────────────────────────────────────
        if (cmd === '.delsudo') {
            const targetJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                              msg.message?.extendedTextMessage?.contextInfo?.participant;

            if (!targetJid) {
                return sock.sendMessage(chat, {
                    text: '❌ Tag a user to revoke node sudo access.'
                }, { quoted: msg });
            }

            const sudoUsers = loadSudoUsers(botId);
            const normalized = normalizeJid(targetJid);
            const digits = extractDigits(targetJid);

            sudoUsers.delete(normalized);
            if (digits) sudoUsers.delete(digits);
            saveSudoUsers(sudoUsers, botId);

            return sock.sendMessage(chat, {
                text: `🔴 *Node Sudo Revoked*\n\n👤 @${targetJid.split('@')[0]}\n🤖 Node: ${botId}`,
                mentions: [targetJid]
            }, { quoted: msg });
        }

        // ── .listsudo ─────────────────────────────────────────────────────
        if (cmd === '.listsudo') {
            const sudoUsers = loadSudoUsers(botId);

            if (sudoUsers.size === 0) {
                return sock.sendMessage(chat, {
                    text: `📭 No sudo users on this node (${botId}).\n\n_Use .setsudo @user to add node-level access._`
                }, { quoted: msg });
            }

            const list = [...sudoUsers].map(jid => `• ${jid}`).join('\n');

            return sock.sendMessage(chat, {
                text: `👑 *NODE SUDO LIST* (Node: ${botId})\n\n${list}\n\n_Total: ${sudoUsers.size}_\n_These users have owner access on this node only._`
            }, { quoted: msg });
        }

        // ── .restart ──────────────────────────────────────────────────────
        if (cmd === '.restart') {
            await sock.sendMessage(chat, {
                text: `🔄 *Restarting bot...*`
            }, { quoted: msg });
            setTimeout(() => process.exit(0), 1500);
            return;
        }

        // ── .setgodcasttmp / .godcasttheme ────────────────────────────────
        // Usage: .setgodcasttmp cyber | girly | guys
        if (cmd === '.setgodcasttmp' || cmd === '.godcasttheme') {
            const { setActiveTheme, getActiveTheme, VALID_THEMES } = require('../core/godcastTemplates');
            const theme = (args[0] || '').toLowerCase().trim();

            if (!theme) {
                const current = getActiveTheme();
                return sock.sendMessage(chat, {
                    text: [
                        `╭─〔 🎨 GODCAST THEME 〕`,
                        `│ ✅ Active  : *${current}*`,
                        `│ 📋 Options : *${VALID_THEMES.join(' · ')}*`,
                        `╰─────────────────`,
                        ``,
                        `_Usage: .setgodcasttmp <theme>_`,
                        `_Example: .setgodcasttmp girly_`,
                    ].join('\n')
                }, { quoted: msg });
            }

            try {
                const applied = setActiveTheme(theme);
                const icons = { cyber: '💻', girly: '🌸', guys: '🔥' };
                return sock.sendMessage(chat, {
                    text: [
                        `╭─〔 🎨 GODCAST THEME SET 〕`,
                        `│ ${icons[applied] || '✅'} Theme : *${applied}*`,
                        `│ 📡 Effect : All future godcast & updategstatus`,
                        `│           drops will use *${applied}* templates`,
                        `╰─────────────────`,
                    ].join('\n')
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(chat, {
                    text: `❌ *${err.message}*`
                }, { quoted: msg });
            }
        }
    },
};
