// plugins/pappy-cache.js
'use strict';

const linkPreviewCache = require('../core/linkPreviewCache');
const logger = require('../core/logger');

module.exports = {
    category: 'UTILITY',
    commands: [
        { cmd: '.cache', role: 'owner' },
    ],

    execute: async ({ sock, msg, args, text, botId }) => {
        const jid = msg.key.remoteJid;
        const cmd = text.split(' ')[0].toLowerCase();

        if (cmd === '.cache') {
            const action = (args[0] || '').toLowerCase();

            // ── .cache (no args) — show current message preview status ─────────
            if (!action) {
                // Check if current message or quoted message has a link preview
                const currentMessageExtended = msg.message?.extendedTextMessage;
                const currentMessageContextInfo = currentMessageExtended?.contextInfo;
                const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                
                const currentText = currentMessageExtended?.text || '';
                const quotedText = quotedMessage?.conversation || quotedMessage?.extendedTextMessage?.text || '';
                
                const hasCurrentPreview = currentMessageContextInfo?.externalAdReply || currentMessageExtended?.matchedText;
                const hasQuotedPreview = quotedMessage?.extendedTextMessage?.contextInfo?.externalAdReply 
                    || quotedMessage?.extendedTextMessage?.matchedText;
                
                if (hasCurrentPreview) {
                    return sock.sendMessage(jid, {
                        text: `✅ *Current message has link preview*\n\n` +
                              `📎 Use \`.cache save\` to cache this preview\n` +
                              `💡 Once cached, it will be used automatically in commands`
                    }, { quoted: msg });
                }
                
                if (hasQuotedPreview) {
                    return sock.sendMessage(jid, {
                        text: `✅ *Quoted message has link preview*\n\n` +
                              `📎 Use \`.cache save\` to cache this preview\n` +
                              `💡 Once cached, it will be used automatically in commands`
                    }, { quoted: msg });
                }
                
                return sock.sendMessage(jid, {
                    text: `❌ *No link preview detected*\n\n` +
                          `📌 *How to cache:*\n` +
                          `1. Send a link and wait for WhatsApp to load the preview\n` +
                          `2. Reply with \`.cache save\` or just use the command directly\n\n` +
                          `📋 *Other commands:*\n` +
                          `• \`.cache list\` — view cached previews\n` +
                          `• \`.cache stats\` — cache statistics\n` +
                          `• \`.cache clear [url]\` — clear cache`
                }, { quoted: msg });
            }

            // ── .cache save — manually cache current/quoted preview ─────────────
            if (action === 'save' || action === 'add') {
                const currentMessageExtended = msg.message?.extendedTextMessage;
                const currentMessageContextInfo = currentMessageExtended?.contextInfo;
                const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                
                const currentText = currentMessageExtended?.text || '';
                const quotedText = quotedMessage?.conversation || quotedMessage?.extendedTextMessage?.text || '';
                
                const hasCurrentPreview = currentMessageContextInfo?.externalAdReply || currentMessageExtended?.matchedText;
                const hasQuotedPreview = quotedMessage?.extendedTextMessage?.contextInfo?.externalAdReply 
                    || quotedMessage?.extendedTextMessage?.matchedText;
                
                let result = null;
                
                if (hasCurrentPreview) {
                    result = linkPreviewCache.cacheFromMessage(msg, currentText);
                } else if (hasQuotedPreview) {
                    // Build a message object from quoted content
                    const quotedMsg = {
                        message: {
                            extendedTextMessage: quotedMessage.extendedTextMessage
                        }
                    };
                    result = linkPreviewCache.cacheFromMessage(quotedMsg, quotedText);
                }
                
                if (!result || !result.cached) {
                    return sock.sendMessage(jid, {
                        text: `❌ *Failed to cache preview*\n\n` +
                              `Reason: ${result?.reason || 'unknown'}\n\n` +
                              `💡 Make sure:\n` +
                              `• The message contains a valid URL\n` +
                              `• WhatsApp has loaded the link preview\n` +
                              `• You're replying to or sending a message with preview`
                    }, { quoted: msg });
                }
                
                return sock.sendMessage(jid, {
                    text: `${result.updated ? '♻️' : '✅'} *Preview ${result.updated ? 'updated' : 'cached'} successfully!*\n\n` +
                          `🔗 URL: ${result.url.slice(0, 60)}${result.url.length > 60 ? '...' : ''}\n` +
                          `📦 Preview type: ${result.preview.type}\n` +
                          `${result.preview.title ? `📝 Title: ${result.preview.title.slice(0, 40)}\n` : ''}` +
                          `\n💡 This preview will now be used automatically in:\n` +
                          `• .godcast\n` +
                          `• .updategstatus / .gstatus\n` +
                          `• .tag`
                }, { quoted: msg });
            }

            // ── .cache list — show cached previews ───────────────────────────────
            if (action === 'list' || action === 'show') {
                const list = linkPreviewCache.listCached();
                
                if (!list.length) {
                    return sock.sendMessage(jid, {
                        text: `📭 *No cached previews*\n\n` +
                              `💡 Send a link with preview and use \`.cache save\` to cache it`
                    }, { quoted: msg });
                }
                
                const page = parseInt(args[1]) || 1;
                const perPage = 10;
                const start = (page - 1) * perPage;
                const end = start + perPage;
                const pageItems = list.slice(start, end);
                const totalPages = Math.ceil(list.length / perPage);
                
                const items = pageItems.map((item, i) => {
                    const num = start + i + 1;
                    return `${num}. ${item.url}\n   📅 ${item.age}d ago | 🔄 ${item.updates}x | ${item.hasThumb ? '🖼️' : '📄'}`;
                }).join('\n\n');
                
                return sock.sendMessage(jid, {
                    text: `📋 *Cached Link Previews*\n\n` +
                          `${items}\n\n` +
                          `📊 Page ${page}/${totalPages} | Total: ${list.length}\n` +
                          `${totalPages > 1 ? `\n💡 Use \`.cache list ${page + 1}\` for next page` : ''}`
                }, { quoted: msg });
            }

            // ── .cache stats — show statistics ───────────────────────────────────
            if (action === 'stats' || action === 'info') {
                const stats = linkPreviewCache.getStats();
                const list = linkPreviewCache.listCached();
                
                const withThumbs = list.filter(i => i.hasThumb).length;
                const avgAge = list.length ? Math.floor(list.reduce((sum, i) => sum + i.age, 0) / list.length) : 0;
                
                return sock.sendMessage(jid, {
                    text: `📊 *Link Preview Cache Statistics*\n\n` +
                          `📦 Cached previews: *${stats.size}* / ${stats.maxSize}\n` +
                          `🖼️ With thumbnails: *${withThumbs}*\n` +
                          `📅 Average age: *${avgAge} days*\n` +
                          `⏰ Cache TTL: *${stats.ttlDays} days*\n\n` +
                          `💡 Previews are cached when you:\n` +
                          `• Use \`.cache save\` manually\n` +
                          `• Send link with preview in commands`
                }, { quoted: msg });
            }

            // ── .cache clear — clear cache ────────────────────────────────────────
            if (action === 'clear' || action === 'delete' || action === 'remove') {
                const url = args.slice(1).join(' ').trim();
                
                if (url) {
                    const deleted = linkPreviewCache.clearCache(url);
                    return sock.sendMessage(jid, {
                        text: deleted 
                            ? `✅ *Preview cleared*\n\n🔗 ${url}` 
                            : `❌ *Preview not found*\n\n🔗 ${url}`
                    }, { quoted: msg });
                }
                
                // Confirm before clearing all
                if (!args[1] || args[1].toLowerCase() !== 'all') {
                    return sock.sendMessage(jid, {
                        text: `⚠️ *Clear ALL cached previews?*\n\n` +
                              `This will delete all ${linkPreviewCache.getStats().size} cached previews.\n\n` +
                              `✅ Confirm: \`.cache clear all\``
                    }, { quoted: msg });
                }
                
                linkPreviewCache.clearCache();
                return sock.sendMessage(jid, {
                    text: `✅ *All cached previews cleared*`
                }, { quoted: msg });
            }

            return sock.sendMessage(jid, {
                text: `📦 *Link Preview Cache*\n\n` +
                      `*Commands:*\n` +
                      `• \`.cache\` — check current message\n` +
                      `• \`.cache save\` — cache current/quoted preview\n` +
                      `• \`.cache list\` — view all cached previews\n` +
                      `• \`.cache stats\` — cache statistics\n` +
                      `• \`.cache clear [url]\` — clear cache\n\n` +
                      `*How it works:*\n` +
                      `1. Send a link and wait for preview to load\n` +
                      `2. Use \`.cache save\` to cache it\n` +
                      `3. Later, use commands without preview - cache will be used\n\n` +
                      `*Auto-caching:*\n` +
                      `Previews are also cached when you use:\n` +
                      `• .godcast with link preview\n` +
                      `• .updategstatus with link preview\n` +
                      `• .tag with link preview`
            }, { quoted: msg });
        }
    }
};
