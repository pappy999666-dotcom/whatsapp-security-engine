// modules/permission.js
// Thin shim — delegates entirely to permissionEngine (the single source of truth).
// Kept for backward compat with any plugin still calling getUserRole().
const permissionEngine = require('./permissionEngine');

function getUserRole(msg, isGroupAdmin = false, botId = null) {
    try {
        if (!msg?.key) return 'public';
        if (msg.key.fromMe) return 'owner';
        const sender = msg.key.participant || msg.key.remoteJid;
        if (!sender) return 'public';
        if (permissionEngine.can(sender, botId, 'node_sudo')) return 'owner';
        return 'public';
    } catch {
        return 'public';
    }
}

module.exports = { getUserRole };
