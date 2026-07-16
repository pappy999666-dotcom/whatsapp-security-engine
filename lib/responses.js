'use strict';

const DIVIDER = '─────────────────';
const CATEGORY_ICONS = Object.freeze({
  utility: '🔧', download: '📥', downloader: '📥', sticker: '🎨', ai: '🧠',
  group: '⚙️', protection: '🛡️', economy: '💰', fun: '🎲', religion: '🕌',
  info: '🔍', stalker: '🔍', owner: '👑', system: '📡', broadcast: '📢',
  intel: '🎯', radar: '🎯', node: '🤖', core: '🤖', support: '❓',
});

function clean(value, max = 4096) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, Math.max(0, Number(max) || 0));
}

function truncate(text, maxLen = 200) {
  const value = clean(text, 100000);
  const limit = Math.max(3, Number(maxLen) || 200);
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function buildDivider() { return DIVIDER; }

function buildHeader(botname = 'Pappy') {
  const name = clean(botname, 40).trim().toUpperCase() || 'PAPPY';
  return `*「 ${name} 」*\n${DIVIDER}`;
}

function buildContextCard({ title = 'PAPPY ULTIMATE', body = '', thumbnailUrl, text = '', footer, nodeMode } = {}) {
  const externalAdReply = {
    title: clean(title, 60),
    body: clean(body, 120),
    mediaType: 1,
    previewType: 0,
    showAdAttribution: false,
    ...(thumbnailUrl ? { thumbnailUrl: clean(thumbnailUrl, 2048) } : {}),
  };
  const footerText = footer || (nodeMode ? `powered by Pappy Ultimate · ${clean(nodeMode, 20)}` : 'powered by Pappy Ultimate');
  return {
    text: [clean(text), DIVIDER, clean(footerText, 100)].filter(Boolean).join('\n'),
    contextInfo: { externalAdReply },
  };
}

function buildTreeList(items = []) {
  return items.map((item, index) => {
    const branch = items.length === 1 ? '└─' : index === 0 ? '┌─' : index === items.length - 1 ? '└─' : '├─';
    const icon = clean(item?.icon, 8);
    const label = clean(item?.label, 80);
    const value = clean(item?.value, 500);
    return `${branch}${icon ? ` ${icon}` : ''}${label ? ` ${label}` : ''}${value ? ` — ${value}` : ''}`;
  }).join('\n');
}

function buildProgressBar(current, total, width = 10) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeCurrent = Math.min(safeTotal, Math.max(0, Number(current) || 0));
  const safeWidth = Math.min(40, Math.max(1, Number(width) || 10));
  const percent = Math.round((safeCurrent / safeTotal) * 100);
  const filled = Math.round((safeCurrent / safeTotal) * safeWidth);
  return `${'▓'.repeat(filled)}${'░'.repeat(safeWidth - filled)} ${percent}%`;
}

function formatUptime(ms) {
  let seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${seconds}s`].filter(Boolean).join(' ');
}

function formatNumber(n) {
  const value = Number(n);
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

function medalFor(rank) {
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return medals[Number(rank) - 1] || `#${Math.max(1, Number(rank) || 1)}`;
}

function header(title, subtitle) {
  return [buildHeader(title), subtitle ? clean(subtitle, 160) : ''].filter(Boolean).join('\n');
}
function footer(botName = 'Pappy', prefix = '.', mode = 'public') {
  return `${DIVIDER}\npowered by ${clean(botName, 40)} · ${clean(mode, 20)} · Prefix ${clean(prefix, 4)}`;
}
function mention(jid) {
  const digits = String(jid || '').split('@')[0].replace(/[^0-9]/g, '');
  return digits ? `@${digits}` : '';
}
function textCard({ title, subtitle, body, fields = [], botName, prefix, mode }) {
  const rows = [header(title || botName, subtitle), clean(body)];
  for (const field of fields.slice(0, 20)) rows.push(`*${clean(field.label, 60)}:* ${clean(field.value, 500)}`);
  rows.push(footer(botName, prefix, mode));
  return rows.filter(Boolean).join('\n\n');
}
function contextInfo({ mentionedJid = [], thumbnail, thumbnailUrl, sourceUrl, title = 'Pappy', body = '' } = {}) {
  const image = thumbnailUrl || thumbnail;
  const externalAdReply = image || sourceUrl ? {
    title: clean(title, 60), body: clean(body, 120), mediaType: 1, previewType: 0,
    showAdAttribution: false, ...(image ? { thumbnailUrl: image } : {}), ...(sourceUrl ? { sourceUrl } : {}),
  } : undefined;
  return { mentionedJid: mentionedJid.filter(Boolean).slice(0, 50), ...(externalAdReply ? { externalAdReply } : {}) };
}
function buttons(items = []) {
  return items.slice(0, 3).map((item, index) => ({
    buttonId: clean(item.id || `action_${index + 1}`, 128),
    buttonText: { displayText: clean(item.text || item.label || 'Select', 40) }, type: 1,
  }));
}
function interactive({ text, footerText = 'powered by Pappy Ultimate', buttons: items = [], headerType = 1, image, video, document }) {
  const media = image ? { image } : video ? { video } : document ? { document } : {};
  return { ...media, text: clean(text), footer: clean(footerText, 60), buttons: buttons(items), headerType };
}
function progress(stage, current, total, detail = '') {
  return `${buildHeader(stage)}\n${buildProgressBar(current, total)}${detail ? `\n${clean(detail, 300)}` : ''}`;
}

module.exports = {
  DIVIDER, CATEGORY_ICONS, clean, truncate, buildHeader, buildDivider, buildContextCard,
  buildTreeList, buildProgressBar, formatUptime, formatNumber, medalFor,
  header, footer, mention, textCard, contextInfo, buttons, interactive, progress,
};
