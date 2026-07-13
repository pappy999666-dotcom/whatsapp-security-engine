'use strict';
// plugins/pappy-sticker.js — PAPPY V2 Sticker Suite

const logger = require('../core/logger');
const { generateAnimatedSticker, generateAnimatedStickerFromVideo } = require('../core/stickerEngine');
const axios = require('axios');

const PACK_NAME   = '×͜×𝕻𝕬𝕻𝕻𝖄×͜×';
const PACK_AUTHOR = '×͜×𝕻𝕬𝕻𝕻𝖄×͜×';
const PACK_ID     = 'pappy-v2';

const NORMAL_META = {
    packName:    PACK_NAME,
    packPublish: PACK_AUTHOR,
    packId:      PACK_ID,
    categories:  ['🔥'],
    isAvatar:    false,
    isAiSticker: false,
};

const PREMIUM_META = {
    packName:    PACK_NAME,
    packPublish: PACK_AUTHOR,
    packId:      PACK_ID,
    categories:  ['🔥'],
    isAvatar:    false,
    isAiSticker: true,
};

function getQuotedContent(msg) {
    return msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

function getMedia(msg) {
    const quoted = getQuotedContent(msg);
    return {
        imageMsg: msg.message?.imageMessage || quoted?.imageMessage || null,
        videoMsg: msg.message?.videoMessage || quoted?.videoMessage || null,
        quoted,
    };
}

async function buildAndSendSticker(sock, jid, msg, imageMsg, videoMsg, quoted, premium = false) {
    const { downloadMediaMessage } = require('@crysnovax/baileys');

    const tick = await sock.sendMessage(jid, {
        text: premium ? '⚡ _Forging premium sticker..._' : '⏳ _Creating sticker..._'
    }, { quoted: msg });

    try {
        let stickerResult;
        if (imageMsg) {
            const src = msg.message?.imageMessage
                ? msg
                : { key: msg.key, message: quoted };
            const buf = await downloadMediaMessage(src, 'buffer', {}, {
                logger: null, reuploadRequest: sock.updateMediaMessage,
            });
            stickerResult = await generateAnimatedSticker(buf);
        } else {
            const src = msg.message?.videoMessage
                ? msg
                : { key: msg.key, message: quoted };
            const buf = await downloadMediaMessage(src, 'buffer', {}, {
                logger: null, reuploadRequest: sock.updateMediaMessage,
            });
            stickerResult = await generateAnimatedStickerFromVideo(buf);
        }

        const sendObj = {
            sticker:         stickerResult.buffer,
            stickerMetadata: premium ? PREMIUM_META : NORMAL_META,
        };
        if (premium) sendObj.verifiedMe = true;

        await sock.sendMessage(jid, sendObj, { quoted: msg });
        await sock.sendMessage(jid, { delete: tick.key }).catch(() => {});
    } catch (err) {
        await sock.sendMessage(jid, { delete: tick.key }).catch(() => {});
        throw err;
    }
}

module.exports = {
    category: 'MEDIA',
    commands: [
        { cmd: '.sticker',  role: 'owner' },
        { cmd: '.s',        role: 'owner' },
        { cmd: '.psticker', role: 'owner' },
        { cmd: '.ps',       role: 'owner' },
        { cmd: '.ptake',    role: 'owner' },
        { cmd: '.ptg',      role: 'owner' },
        { cmd: '.tg',       role: 'owner' },
    ],

    execute: async ({ sock, msg, args }) => {
        const jid = msg.key.remoteJid;
        const rawText = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || msg.message?.imageMessage?.caption
            || '';
        const rawCmd = rawText.trim().split(/\s+/)[0].toLowerCase();
        const cmd = rawCmd.startsWith('.') ? rawCmd : `.${rawCmd}`;

        // ── .sticker / .s  (standard) ──────────────────────────────────────────
        // ── .psticker / .ps (premium + verifiedMe) ─────────────────────────────
        if (['.sticker', '.s', '.psticker', '.ps'].includes(cmd)) {
            const premium = ['.psticker', '.ps'].includes(cmd);
            const { imageMsg, videoMsg, quoted } = getMedia(msg);

            if (!imageMsg && !videoMsg) {
                return sock.sendMessage(jid, {
                    text: `  ⟡ _Reply to an image or video with *${cmd}*`
                }, { quoted: msg });
            }
            try {
                await buildAndSendSticker(sock, jid, msg, imageMsg, videoMsg, quoted, premium);
                logger.info(`[Sticker] ${cmd} ok premium=${premium}`);
            } catch (err) {
                logger.error(`[Sticker] ${cmd} error: ${err.message}`);
                await sock.sendMessage(jid, {
                    text: `  ⟡ _Sticker failed: ${err.message}_`
                }, { quoted: msg });
            }
            return;
        }

        // ── .ptake — steal a sticker & re-stamp with ×͜×𝕻𝕬𝕻𝕻𝖄×͜× pack ──────────
        if (cmd === '.ptake') {
            const { downloadMediaMessage } = require('@crysnovax/baileys');
            const quoted = getQuotedContent(msg);
            const stickerMsg = quoted?.stickerMessage || null;

            if (!stickerMsg) {
                return sock.sendMessage(jid, {
                    text: '  ⟡ _Reply to a sticker with .ptake_'
                }, { quoted: msg });
            }

            const tick = await sock.sendMessage(jid, {
                text: '⚡ _Claiming sticker..._'
            }, { quoted: msg });

            try {
                const pseudoMsg = {
                    key:     msg.key,
                    message: { stickerMessage: stickerMsg },
                };
                const buf = await downloadMediaMessage(pseudoMsg, 'buffer', {}, {
                    logger: null, reuploadRequest: sock.updateMediaMessage,
                });

                await sock.sendMessage(jid, {
                    sticker:         buf,
                    stickerMetadata: PREMIUM_META,
                    verifiedMe:      true,
                }, { quoted: msg });

                await sock.sendMessage(jid, { delete: tick.key }).catch(() => {});
                logger.info('[Sticker] .ptake ok');
            } catch (err) {
                await sock.sendMessage(jid, { delete: tick.key }).catch(() => {});
                logger.error(`[Sticker] .ptake error: ${err.message}`);
                await sock.sendMessage(jid, {
                    text: `  ⟡ _Failed: ${err.message}_`
                }, { quoted: msg });
            }
            return;
        }

        // ── .tg / .ptg — Download a full Telegram sticker pack ─────────────────
        if (['.tg', '.ptg'].includes(cmd)) {
            const premium = cmd === '.ptg';
            const TG_TOKEN = process.env.TG_BOT_TOKEN;
            if (!TG_TOKEN) {
                return sock.sendMessage(jid, {
                    text: '  ⟡ _TG_BOT_TOKEN not configured_'
                }, { quoted: msg });
            }

            // Accept: https://t.me/addstickers/PackName  OR  just PackName
            const raw = (args[0] || '').trim();
            const packName = raw
                .replace(/^https?:\/\/t\.me\/addstickers\//i, '')
                .replace(/\s+/g, '');

            if (!packName) {
                return sock.sendMessage(jid, {
                    text: [
                        `  ⟡ _Usage: *${cmd}* <pack_link or name>_`,
                        `  _Example: ${cmd} https://t.me/addstickers/YourPack_`,
                    ].join('\n')
                }, { quoted: msg });
            }

            const statusMsg = await sock.sendMessage(jid, {
                text: `${premium ? '⚡' : '📦'} _Fetching Telegram pack: *${packName}*..._`
            }, { quoted: msg });

            try {
                const base = `https://api.telegram.org/bot${TG_TOKEN}`;

                // 1. Get sticker set metadata
                const setRes = await axios.get(`${base}/getStickerSet`, {
                    params: { name: packName }, timeout: 15000,
                });
                if (!setRes.data?.ok) throw new Error(`Pack not found: ${packName}`);

                const { title, stickers } = setRes.data.result;
                const total = stickers.length;

                await sock.sendMessage(jid, {
                    text: `✅ _Found: *${title}* — *${total}* stickers. Sending now..._`
                }, { quoted: msg });

                let sent = 0, skipped = 0;

                for (const sticker of stickers) {
                    try {
                        // Skip animated TGS — needs special Lottie renderer
                        if (sticker.is_animated) { skipped++; continue; }

                        const fileRes = await axios.get(`${base}/getFile`, {
                            params: { file_id: sticker.file_id }, timeout: 10000,
                        });
                        if (!fileRes.data?.ok) { skipped++; continue; }

                        const filePath = fileRes.data.result.file_path;
                        const fileUrl  = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;

                        const dlRes = await axios.get(fileUrl, {
                            responseType: 'arraybuffer', timeout: 30000,
                        });
                        let buf = Buffer.from(dlRes.data);

                        // Video webm stickers — convert via ffmpeg
                        if (sticker.is_video || filePath.endsWith('.webm')) {
                            try {
                                const result = await generateAnimatedStickerFromVideo(buf);
                                buf = result.buffer;
                            } catch { skipped++; continue; }
                        }

                        const sendObj = {
                            sticker:         buf,
                            stickerMetadata: premium ? PREMIUM_META : NORMAL_META,
                        };
                        if (premium) sendObj.verifiedMe = true;

                        await sock.sendMessage(jid, sendObj);
                        sent++;

                        // Pace delivery to avoid flooding
                        await new Promise(r => setTimeout(r, 700));
                    } catch { skipped++; }
                }

                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
                await sock.sendMessage(jid, {
                    text: [
                        `╭─〔 📦 STICKER PACK 〕`,
                        `│ 📝 Pack     : *${title}*`,
                        `│ ✅ Sent     : *${sent}*`,
                        `│ ⏭ Skipped  : *${skipped}*`,
                        `│ 🔖 Type     : ${premium ? '⚡ *Premium*' : '📦 *Standard*'}`,
                        `│ 🏷 Name     : *${PACK_NAME}*`,
                        `╰─────────────────`,
                    ].join('\n')
                }, { quoted: msg });

                logger.info(`[Sticker] ${cmd} pack="${title}" sent=${sent} skipped=${skipped}`);
            } catch (err) {
                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
                logger.error(`[Sticker] ${cmd} error: ${err.message}`);
                await sock.sendMessage(jid, {
                    text: `  ⟡ _Failed: ${err.message}_`
                }, { quoted: msg });
            }
            return;
        }
    },
};
