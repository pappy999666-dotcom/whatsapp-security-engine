'use strict';
// core/telegram/index.js
// ─── TELEGRAM MODULE — MODULAR ENTRY POINT ────────────────────────────────────
//
// This index wires together the Telegram bot lifecycle.
// Sub-modules are loaded in dependency order:
//   1. rbac       — role-based access control (already modular)
//   2. cmdRegistry— command registry
//   3. main       — the legacy monolith (startTelegram implementation)
//
// The long-term goal is to extract each handler domain into its own sub-module:
//   pairing.js    — /pair, /kill, /nodes, /restart
//   broadcast.js  — /godcast, /gcast, /ggstatus, /gstatus, /setnewgcstatus
//   intel.js      — /intel, /joinlinks, /validator
//   admin.js      — /sudo, /owner, /ban, /unban, /setcommands
//   ai.js         — /ai, /aivibe, /setprompt
//   status.js     — /updategstatus, /advanced_status
//   sticker.js    — /sticker, /toimg, /tomp3
//   support.js    — /report, /support, /inbox
//
// For now, the main monolith is re-exported here to preserve all functionality
// while the directory structure is established.

const telegramMain = require('../telegram');

module.exports = telegramMain;
