'use strict';
// modules/menuEngine.js — PAPPY V2 (Cyber Edition)

const fs   = require('fs');
const path = require('path');

const CATEGORY_ORDER = [
  'CORE', 'ADMIN', 'STATUS', 'MAGIC', 'BROADCAST', 'MEDIA', 'MUSIC', 'AESTHETIC',
  'INTEL', 'STEALTH', 'STRIKE', 'TRIGGERS', 'GROWTH_ENGINE', 'UTILITY', 'GENERAL',
];

const CAT_ICON = {
  CORE: '⚙️', ADMIN: '🛡️', STATUS: '📡', MAGIC: '🪄', BROADCAST: '📢',
  MEDIA: '🎬', MUSIC: '🎵', AESTHETIC: '🎨', INTEL: '🧠', STEALTH: '🥷',
  STRIKE: '⚔️', TRIGGERS: '⚡', GROWTH_ENGINE: '🌱', UTILITY: '🧰',
  STICKER: '🎨', IMAGE: '🖼️', AI: '🤖', SYSTEM: '💻', GENERAL: '✨',
};

const VIBES = [
  'clean build. cleaner output.',
  'built different. runs different.',
  'every command encrypted.',
  'signal. zero static.',
  'no lag. no mercy.',
  'fast hands. faster bot.',
  'one tap. zero delay.',
  'precision over noise.',
  'engineered to dominate.',
  'ghost mode. always on.',
  'the system never sleeps.',
  'zero trust. full access.',
];

function vibe() { return VIBES[Math.floor(Math.random() * VIBES.length)]; }

function fmtBytes(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  const gb = b / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  return `${(b / 1024 / 1024).toFixed(0)}MB`;
}

function uptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
  return `${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
}

function dateStamp() {
  return new Date().toLocaleString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function roleBadge(role) {
  const r = String(role || 'public').toLowerCase();
  if (r === 'owner') return 'Owner';
  if (r === 'admin') return 'Sudo';
  return 'Member';
}

function prettyCat(cat) {
  return String(cat || '').replace(/_/g, ' ');
}

// Layout commands 3-per-line in │ rows
function cmdRows(list, perLine = 3) {
  const rows = [];
  for (let i = 0; i < list.length; i += perLine) {
    rows.push(`│ ${list.slice(i, i + perLine).join('  ')}`);
  }
  return rows;
}

function generateMenu(user = {}, opts = {}) {
  const userRole = String(opts.userRole || 'public').toLowerCase();
  const prefix   = String(opts.prefix || '.');
  const name     = String(user.name || 'User');
  const number   = String(user.number || '').replace(/[^0-9]/g, '') || '—';
  const cmdsUsed = user.cmdsUsed != null ? user.cmdsUsed : 0;
  const upStr    = user.uptimeSec != null ? uptime(user.uptimeSec) : '—';
  const ramStr   = (user.ramUsed != null && user.ramTotal != null)
    ? `${fmtBytes(user.ramUsed)} / ${fmtBytes(user.ramTotal)}`
    : (user.ramUsed != null ? fmtBytes(user.ramUsed) : '—');

  // Scan plugins
  const pluginsDir = path.join(__dirname, '../plugins');
  const files      = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
  const menuMap    = {};
  const seen       = new Set();

  for (const file of files) {
    try {
      const plugin = require(path.join(pluginsDir, file));
      if (!plugin.commands) continue;
      const cat = String(plugin.category || 'GENERAL').toUpperCase();
      if (!menuMap[cat]) menuMap[cat] = [];
      for (const command of plugin.commands) {
        const rawName = String(command.cmd || '').trim();
        if (!rawName) continue;
        const clean = rawName.replace(/^[^a-zA-Z0-9]+/, '');
        if (!clean) continue;
        const display = `${prefix}${clean}`;
        if (seen.has(display)) continue;
        if (!hasPermission(userRole, command.role)) continue;
        seen.add(display);
        menuMap[cat].push(display);
      }
    } catch {}
  }

  const cats      = [...new Set([...CATEGORY_ORDER, ...Object.keys(menuMap)])].filter(c => menuMap[c]?.length);
  const totalCmds = cats.reduce((sum, c) => sum + (menuMap[c]?.length || 0), 0);
  const totalMods = cats.length;

  const DIV = '─────────────────';

  const lines = [];

  // ── HEADER ─────────────────────────────────────────────────────────────────
  lines.push('╭━━━〔 ⚡ PAPPY V2 ⚡ 〕━━━╮');
  lines.push('┃   Premium WhatsApp System');
  lines.push('╰━━━━━━━━━━━━━━━━━━━━━━━╯');
  lines.push('');

  // ── USER INFO ──────────────────────────────────────────────────────────────
  lines.push('┌─〔 USER INFO 〕');
  lines.push(`│ 👤 User     : *${name}*`);
  lines.push(`│ 👑 Role     : *${roleBadge(userRole)}*`);
  lines.push(`│ 📟 Node     : *${number}*`);
  lines.push(`│ 🔖 Prefix   : *${prefix}*`);
  lines.push(`│ 🧩 Commands : *${totalCmds}*`);
  lines.push(`│ 📦 Modules  : *${totalMods}*`);
  lines.push(`│ 📊 Used     : *${cmdsUsed}*`);
  lines.push(`│ ⏱️ Uptime   : *${upStr}*`);
  lines.push(`│ 🧠 RAM      : *${ramStr}*`);
  lines.push(`│ 💻 Runtime  : *Linux VPS*`);
  lines.push(`│ 🕒 Time     : *${dateStamp()}*`);
  lines.push(`└${DIV}`);
  lines.push('');

  // ── SYSTEM STATUS ──────────────────────────────────────────────────────────
  lines.push('╭─〔 SYSTEM STATUS 〕');
  lines.push('│ ⚡ Speed      : *Stable*');
  lines.push('│ 🔥 Engine     : *PAPPY Core*');
  lines.push('│ 🛰️ Platform   : *Baileys*');
  lines.push('│ 📡 Connection : *Online*');
  lines.push('│ 🔐 Mode       : *Owner Only*');
  lines.push('│ 🧬 Queue      : *Active*');
  lines.push(`╰${DIV}`);
  lines.push('');

  // ── COMMAND MODULES ────────────────────────────────────────────────────────
  lines.push('『 COMMAND MODULES 』');
  lines.push('');

  for (const cat of cats) {
    const list = menuMap[cat];
    if (!list?.length) continue;
    const icon = CAT_ICON[cat] || '✨';
    lines.push(`╭─❖ ${icon} ${prettyCat(cat)} [${list.length}]`);
    for (const row of cmdRows(list, 3)) lines.push(row);
    lines.push(`╰${DIV}`);
    lines.push('');
  }

  // ── FOOTER ─────────────────────────────────────────────────────────────────
  lines.push('━━━━━━━━━━━━━━━━━━━');
  lines.push('⚡ *PAPPY V2*');
  lines.push('🛰️ Fast • Clean • Powerful');
  lines.push(`✦ _"${vibe()}"_`);
  lines.push('━━━━━━━━━━━━━━━━━━━');

  return lines.join('\n');
}

function hasPermission(userRole, requiredRole = 'owner') {
  const roles = { public: 1, admin: 2, owner: 3 };
  return (roles[userRole] || 1) >= (roles[requiredRole] || 3);
}

module.exports = { generateMenu };
