'use strict';
// modules/uiTheme.js — PULSE Design System
// v2: rare geometric glyphs (⟢ ⬡ ⌬ ⧉ etc.) don't have font coverage on every
// phone and render as blank "tofu" boxes for some users — switched to
// universally-supported colour emoji so the menu actually looks the same
// (and looks alive) everywhere. Box-drawing borders (╭─╮ etc.) are kept —
// those have solid cross-platform support.

// ── Geometric symbol palette (kept for borders / fine accents only) ──────────
const SYM = {
  core:    '⚙️',
  admin:   '🛡️',
  status:  '📡',
  media:   '🎬',
  sticker: '🎨',
  music:   '🎵',
  image:   '🖼️',
  ai:      '🤖',
  intel:   '🧠',
  system:  '💻',
  general: '✨',
  nexus:   '🌐',
  warmup:  '🔥',
  dot:     '·',
  sep:     '›',
  dbl:     '»',
  star:    '✦',
  diamond: '💎',
  tri:     '🔺',
  ring:    '◎',
  hex:     '⬡',
  cross:   '✧',
};

// ── Box builder ───────────────────────────────────────────────────────────────
// width = inner character width (content between │ and │)
function box(title, width = 26) {
  const pad = Math.max(0, width - title.length);
  const lpad = Math.floor(pad / 2);
  const rpad = pad - lpad;
  return [
    `╭${'─'.repeat(width + 2)}╮`,
    `│ ${' '.repeat(lpad)}${title}${' '.repeat(rpad)} │`,
    `╰${'─'.repeat(width + 2)}╯`,
  ].join('\n');
}

// Slim single-line divider
function divider(width = 28) {
  return `${'┄'.repeat(width)}`;
}

// Thick accent divider
function accentLine(width = 28) {
  return `${'━'.repeat(width)}`;
}

// ── Label row ────────────────────────────────────────────────────────────────
// e.g.  🛡️ Latency   »  *45ms*
function row(icon, label, value, pad = 10) {
  const labelPadded = label.padEnd(pad);
  return `  ${icon} ${labelPadded}» ${value}`;
}

// ── Progress bar ─────────────────────────────────────────────────────────────
function bar(value, max, len = 12) {
  const filled = Math.round((value / max) * len);
  return '▰'.repeat(filled) + '▱'.repeat(len - filled);
}

// ── Ping quality ─────────────────────────────────────────────────────────────
function pingBar(ms) {
  if (ms < 100)  return `▰▰▰▰▰▰▰▰▰▰▰▰ 🚀 *BLAZING*`;
  if (ms < 250)  return `▰▰▰▰▰▰▰▰▰▱▱▱ ⚡ *FAST*`;
  if (ms < 500)  return `▰▰▰▰▰▰▱▱▱▱▱▱ ✅ *STABLE*`;
  if (ms < 900)  return `▰▰▰▰▱▱▱▱▱▱▱▱ 🐢 *SLOW*`;
  return              `▰▰▱▱▱▱▱▱▱▱▱▱ 🔴 *CRITICAL*`;
}

// ── Role badge ───────────────────────────────────────────────────────────────
function roleBadge(role) {
  const r = String(role || 'public').toLowerCase();
  if (r === 'owner') return '👑 OWNER';
  if (r === 'admin') return '🛡️ ADMIN';
  return '👤 MEMBER';
}

// ── Uptime formatter ─────────────────────────────────────────────────────────
function uptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

// ── Memory formatter ─────────────────────────────────────────────────────────
function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

// ── Live date/time stamp ──────────────────────────────────────────────────────
function dateStamp() {
  const d = new Date();
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Category icons (uppercase key → emoji) ────────────────────────────────────
const CAT_ICON = {
  CORE:          '⚙️',
  ADMIN:         '🛡️',
  STATUS:        '📡',
  MAGIC:         '🪄',
  BROADCAST:     '📢',
  MEDIA:         '🎬',
  MUSIC:         '🎵',
  AESTHETIC:     '🎨',
  INTEL:         '🧠',
  STEALTH:       '🥷',
  STRIKE:        '⚔️',
  TRIGGERS:      '⚡',
  GROWTH_ENGINE: '🌱',
  UTILITY:       '🧰',
  STICKER:       '🎨',
  IMAGE:         '🖼️',
  AI:            '🤖',
  SYSTEM:        '💻',
  GENERAL:       '✨',
  NEXUS:         '🌐',
  WARMUP:        '🔥',
};

// ── Vibes ─────────────────────────────────────────────────────────────────────
const VIBES = [
  'clean build, cleaner output.',
  'precision over noise.',
  'built different, runs different.',
  'every command, encrypted.',
  'the system never sleeps.',
  'speed is a feature.',
  'less talk, more execution.',
  'engineered to dominate.',
  'signal. no static.',
  'no lag, no mercy.',
  'fast hands, faster bot.',
  'one tap. zero lag.',
];

function vibe() {
  return VIBES[Math.floor(Math.random() * VIBES.length)];
}

module.exports = { SYM, CAT_ICON, VIBES, box, divider, accentLine, row, bar, pingBar, roleBadge, uptime, mb, dateStamp, vibe };
