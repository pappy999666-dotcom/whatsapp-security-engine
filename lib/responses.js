'use strict';

const DIVIDER = '━━━━━━━━━━━━━━━━━━';
const CATEGORY_ICONS = Object.freeze({ core: '◆', download: '↓', sticker: '◇', ai: '✦', group: '▣', protection: '◈', info: 'ℹ', fun: '•', economy: '¤', utility: '▪', broadcast: '◎', intel: '⌁', owner: '⬡', support: '?' });
const clean = (value, max = 4096) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
function header(title, subtitle) { return [`┏ ${clean(title, 80)}`, subtitle ? `┃ ${clean(subtitle, 160)}` : null, `┗ ${DIVIDER}`].filter(Boolean).join('\n'); }
function footer(botName = 'Pappy', prefix = '.', mode = 'public') { return `${DIVIDER}\n${clean(botName, 40)} • Prefix ${clean(prefix, 4)} • ${clean(mode, 20)}`; }
function mention(jid) { const digits = String(jid || '').split('@')[0].replace(/[^0-9]/g, ''); return digits ? `@${digits}` : ''; }
function textCard({ title, subtitle, body, fields = [], botName, prefix, mode }) { const rows = [header(title, subtitle), clean(body)]; for (const field of fields.slice(0, 20)) rows.push(`${clean(field.label, 60)}: ${clean(field.value, 500)}`); rows.push(footer(botName, prefix, mode)); return rows.filter(Boolean).join('\n\n'); }
function contextInfo({ mentionedJid = [], thumbnail, sourceUrl, title = 'Pappy', body = '' } = {}) { const externalAdReply = thumbnail || sourceUrl ? { title: clean(title, 60), body: clean(body, 120), mediaType: 1, renderLargerThumbnail: Boolean(thumbnail), thumbnail, sourceUrl } : undefined; return { mentionedJid: mentionedJid.filter(Boolean).slice(0, 50), ...(externalAdReply ? { externalAdReply } : {}) }; }
function buttons(items = []) { return items.slice(0, 3).map((item, index) => ({ buttonId: clean(item.id || `action_${index + 1}`, 128), buttonText: { displayText: clean(item.text || item.label || 'Select', 40) }, type: 1 })); }
function interactive({ text, footerText = 'Pappy', buttons: items = [], headerType = 1, image, video, document }) { const media = image ? { image } : video ? { video } : document ? { document } : {}; return { ...media, text: clean(text), footer: clean(footerText, 60), buttons: buttons(items), headerType }; }
function progress(stage, current, total, detail = '') { const safeTotal = Math.max(1, Number(total) || 1); const safeCurrent = Math.min(safeTotal, Math.max(0, Number(current) || 0)); const percent = Math.round((safeCurrent / safeTotal) * 100); const filled = Math.round(percent / 10); return `${header(stage)}\n${'■'.repeat(filled)}${'□'.repeat(10 - filled)} ${percent}%${detail ? `\n${clean(detail, 300)}` : ''}`; }
module.exports = { DIVIDER, CATEGORY_ICONS, clean, header, footer, mention, textCard, contextInfo, buttons, interactive, progress };
