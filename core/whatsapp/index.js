'use strict';
// core/whatsapp/index.js
// ─── WHATSAPP MODULE — MODULAR ENTRY POINT ────────────────────────────────────
//
// This index wires together the WhatsApp connection lifecycle.
// Sub-modules to be extracted:
//   socket.js     — makeWASocket, connection, auth, reconnect
//   events.js     — message, group, participant event handlers
//   antiHook.js   — anti-system integration (calls antiEngine.processAntiChecks)
//   groupAdmin.js — kick, promote, demote, rename, settings
//   media.js      — download, send, convert
//   broadcast.js  — broadcastQueue delegation to bullEngine
//
// For now, the main monolith is re-exported here while the directory structure
// is established. Each sub-module will be extracted progressively.

const whatsappMain = require('../whatsapp');

module.exports = whatsappMain;
