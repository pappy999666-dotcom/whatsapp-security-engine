// core/commandRouter.js
const fs = require('fs');
const path = require('path');
const eventBus = require('./eventBus');
const rateLimiter = require('../services/rateLimiter');
const userEngine = require('../modules/userEngine');
const ownerManager = require('../modules/ownerManager');
const logger = require('./logger');
const softWork = require('./softWork');
const runtimeFlags = require('./runtimeFlags');
const { enqueueHeavyCommand } = require('./commandScheduler');
const { sendPremiumText } = require('./responseEngine');
const { globalPrefix } = require('../config');
const permissionEngine = require('../modules/permissionEngine');

const HEAVY_COMMANDS = new Set([
    '.godcast', '.gcast', '.ggstatus', '.setnewgcstatus',
    '.updategstatus', '.schedulecast', '.schedulegodcast',
    '.loopcast', '.loopgodcast'
]);

// Commands that run at most 1 at a time per node — prevents socket saturation
const SERIALIZED_COMMANDS = new Set([
    '.tag', '.tagall', '.ban', '.kick', '.promote', '.demote',
    '.announce', '.delete', '.broadcast', '.invite',
]);

class CommandRouter {
    constructor() {
        this.plugins = new Map();
        this._running = new Map(); // runKey(botId:cmd) -> active execution count
        // Increased for nodes with many groups - prevents command blocking
        this._MAX_CONCURRENT_PER_CMD_PER_NODE = 5;
        // Serialized commands: max 2 concurrent per node (allow some parallelism)
        this._MAX_CONCURRENT_SERIALIZED = 2;
        // Instant commands bypass concurrency gates, execute immediately
        this._INSTANT_COMMANDS = new Set(['.play', '.search', '.menu', '.ping', '.info', '.help', '.cache', '.warns', '.groupsettings']);
        this.loadPlugins();
        this.initBus();
    }

    getCommandTimeoutMs(commandName) {
        const timeouts = {
            '.play': 180000,
            '.song': 180000,
            '.video': 240000,
            '.img': 180000,
            '.gcast': 180000,
            '.godcast': 240000,
            '.schedulecast': 180000,
            '.schedulegodcast': 240000,
            '.loopcast': 180000,
            '.loopgodcast': 240000,
            '.lag': 300000,
        };
        return timeouts[String(commandName || '').toLowerCase()] || 60000;
    }

    loadPlugins() {
        const dir = path.join(__dirname, '../plugins');
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
        
        for (const file of files) {
            try {
                const plugin = require(path.join(dir, file));
                
                // Attach boot listeners for plugins that need them (like Intel/Watchdog)
                if (plugin.init) {
                    // Fire on system.boot (existing sessions on startup)
                    eventBus.on('system.boot', (sock) => {
                        try { plugin.init(sock); } catch(e) { logger.error(`Init error in ${file}`, e); }
                    });
                    // Also fire on every socket open — covers fresh pairs
                    eventBus.on('socket.open', (sock) => {
                        try { plugin.init(sock); } catch(e) { logger.error(`Init error in ${file}`, e); }
                    });
                }

                // Register every command in the plugin to our RAM cache
                if (plugin.commands && Array.isArray(plugin.commands)) {
                    plugin.commands.forEach(cmd => {
                        this.plugins.set(cmd.cmd.toLowerCase(), {
                            execute: plugin.execute,
                            category: plugin.category,
                            config: cmd, // Stores role, description, etc.
                            file
                        });
                    });
                }
            } catch (err) { logger.error(`Failed to load plugin: ${file}`, err); }
        }
        logger.system(`🚀 Command Router Online: ${this.plugins.size} commands cached.`);
    }

    initBus() {
        const BOT_ADMIN_GATE_EXEMPT_COMMANDS = new Set([
            '.updategstatus'
        ]);

        // Single canonical permission check — delegates entirely to permissionEngine.
        // Covers: global_owner (env + owner.json), node_owner (paired number),
        // node_sudo (per-node sudo list). No inline logic duplicated here.
        // WHY: the old implementation had 3 separate copies of owner/sudo resolution
        // across commandRouter, permission.js, and whatsapp.js causing divergence bugs.
        const isOwnerSender = (sender, msg, botId) => {
            if (msg?.key?.fromMe) return true;

            const candidates = [
                sender,
                msg?.key?.participant,
                msg?.key?.participantPn,
                msg?.key?.remoteJid,
                msg?.message?.extendedTextMessage?.contextInfo?.participant,
                msg?.message?.imageMessage?.contextInfo?.participant,
                msg?.message?.videoMessage?.contextInfo?.participant,
                msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.participant,
                msg?.message?.ephemeralMessage?.message?.imageMessage?.contextInfo?.participant,
                msg?.message?.ephemeralMessage?.message?.videoMessage?.contextInfo?.participant,
            ].filter(Boolean);

            const bid = String(botId || '');
            for (const candidate of candidates) {
                // can() checks global_owner >= node_owner >= node_sudo threshold
                if (permissionEngine.can(candidate, bid, permissionEngine.ROLES.NODE_SUDO)) return true;
                // Legacy ownerManager delegates owner checks to permissionEngine.
                // Do NOT accept owner.json sudoJids here: WhatsApp sudo must be per-node only.
                if (ownerManager.isOwner(candidate)) return true;
            }

            // Node owner: the WA number that IS this bot node is always its own owner.
            if (bid) {
                const nodeDigits = bid.replace(/[^0-9]/g, '');
                if (nodeDigits && candidates.some((jid) => String(jid || '').replace(/[^0-9]/g, '') === nodeDigits)) {
                    return true;
                }
            }

            return false;
        };

        eventBus.on('message.upsert', async (payload) => {
            // Wrap entire handler — no error should ever stop message processing
            try {
            const { sock, msg, text, isGroup, sender, botId, isGroupAdmin, botIsGroupAdmin, resolveIsGroupAdmin, resolveBotIsGroupAdmin } = payload;
            
            if (!sock || !msg || !botId) return;
            
            const sockBotId = sock.user?.id?.split(':')[0];
            if (sockBotId && botId && sockBotId !== botId) return;

            if (!text || !text.startsWith(globalPrefix)) return;

            // fromMe=true in a group = owner sent from their paired number — treat as owner on ALL nodes
            const senderIsOwner = msg.key.fromMe ? true : isOwnerSender(sender, msg, botId);

            // OWNER/SUDO ONLY — no member or group admin can use any command
            if (!senderIsOwner) return;

            // DM is owner-only.
            if (!isGroup && !senderIsOwner) return;

            try {
                // 2. Command Parsing
                const args = text.slice(globalPrefix.length).trim().split(/ +/);
                let rawCmd = (args.shift() || '').toLowerCase();
                let commandName = `${globalPrefix}${rawCmd}`;

                // 3. Registry Lookup — also handles glued typos like `.menucat` → `.menu`
                let command = this.plugins.get(commandName);
                if (!command) {
                    // try stripping trailing non-alpha chars or extra text glued to cmd
                    // e.g. `.menucat` → try `.menuca`, `.menuc`, `.menu` etc.
                    for (let i = rawCmd.length - 1; i >= 2; i--) {
                        const shorter = `${globalPrefix}${rawCmd.slice(0, i)}`;
                        if (this.plugins.has(shorter)) {
                            // push the stripped suffix back as first arg
                            const stripped = rawCmd.slice(i);
                            if (stripped) args.unshift(stripped);
                            rawCmd = rawCmd.slice(0, i);
                            commandName = shorter;
                            command = this.plugins.get(shorter);
                            break;
                        }
                    }
                }
                if (!command || !command.execute) return;

                // For admin commands, bot must be admin in the group. Silently ignore otherwise.
                if (isGroup && command.config.role === 'admin' && !senderIsOwner && !BOT_ADMIN_GATE_EXEMPT_COMMANDS.has(commandName)) {
                    let effectiveBotIsAdmin = !!botIsGroupAdmin;
                    if (!effectiveBotIsAdmin && typeof resolveBotIsGroupAdmin === 'function') {
                        try {
                            effectiveBotIsAdmin = !!(await resolveBotIsGroupAdmin());
                        } catch {}
                    }
                    if (!effectiveBotIsAdmin) return;
                }

                // 4. Database Sync (User Clearance)
                let effectiveIsGroupAdmin = !!isGroupAdmin;
                if (isGroup && !effectiveIsGroupAdmin && command.config.role === 'admin' && typeof resolveIsGroupAdmin === 'function') {
                    try {
                        effectiveIsGroupAdmin = !!(await resolveIsGroupAdmin());
                    } catch {}
                }

                const userProfile = await userEngine.getOrCreate(sender, msg.pushName || 'Unknown', effectiveIsGroupAdmin);
                if (userProfile?.activity?.isBanned) return;

                // Set owner role if sender is recognized as owner
                if (senderIsOwner) {
                    userProfile.role = 'owner';
                }

                // 5. Role Verification (SaaS Armor)
                let userRole = userProfile.role || 'public';
                const requiredRole = command.config.role || 'public';

                // OWNER-ONLY MODE: strip admin role from non-owners completely.
                // Group admins who are not recognized as owner/sudo have no elevated access.
                if (!senderIsOwner && userRole === 'admin') {
                    userRole = 'public';
                }

                // DM behavior: allow only public commands for non-owners.
                if (!isGroup && !senderIsOwner && requiredRole !== 'public') {
                    return;
                }

                // Owner override for role gates: if sender is recognized owner by any source,
                // treat as owner even if DB role cache is stale.
                if (senderIsOwner && requiredRole !== 'public') {
                    userProfile.role = 'owner';
                    userRole = 'owner';
                }
                
                const roles = { 'public': 1, 'admin': 2, 'owner': 3 };
                if ((roles[userRole] || 1) < (roles[requiredRole] || 1)) {
                    return; // silently drop — no access denied message
                }

                // 6. Rate Limiting
                const groupId = isGroup ? msg.key.remoteJid : null;
                const isAllowed = await rateLimiter.check(sender, groupId, commandName);
                if (!isAllowed) return;

                // 7. Update Analytics (non-blocking)
                userEngine.recordCommand(sender).catch(() => {});

                const runCommand = async (abortSignal) => {
                    // SoftWork delay runs BEFORE acquiring the concurrency slot
                    // so it never holds a slot open while waiting
                    // SKIP SOFTWORK FOR OWNERS - they need instant response
                    let delayMs = 0;
                    if (userRole !== 'owner') {
                        const senderJid = String(sender || '').trim();
                        const softWorkSenderKey = `${senderJid}::${String(botId || 'global')}`;
                        delayMs = await softWork.applySoftDelay(commandName, softWorkSenderKey);
                    }

                    if (command.execute.length === 1) {
                        await command.execute({ sock, msg, args, text, user: userProfile, isGroup, botId, abortSignal, softWorkDelay: delayMs });
                    } else {
                        await command.execute(sock, msg, args, userProfile, commandName, abortSignal);
                    }
                };

                // Instant commands bypass concurrency gates
                const isInstant = this._INSTANT_COMMANDS.has(commandName);
                // Serialized commands: max 1 concurrent per node (admin/moderation ops)
                const isSerialized = SERIALIZED_COMMANDS.has(commandName);
                const maxConcurrent = isSerialized
                    ? this._MAX_CONCURRENT_SERIALIZED
                    : this._MAX_CONCURRENT_PER_CMD_PER_NODE;

                const executeWithTimeout = () => {
                    const runKey = `${String(botId || 'global')}:${String(commandName || '').toLowerCase()}`;
                    const activeCount = this._running.get(runKey) || 0;

                    if (!isInstant && activeCount >= maxConcurrent) {
                        logger.warn(`[CommandRouter] Concurrency limit (${maxConcurrent}) hit for ${commandName} on ${botId}, dropping`);
                        return;
                    }

                    if (!isInstant) {
                        this._running.set(runKey, activeCount + 1);
                    }

                    eventBus.emit('command.trace', {
                        botId,
                        commandName,
                        sender,
                        remoteJid: msg?.key?.remoteJid,
                        status: 'start',
                    });

                    // Per-command timeout: media/broadcast gets longer windows.
                    const timeoutMs = this.getCommandTimeoutMs(commandName);
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Command execution timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs)
                    );

                    Promise.race([runCommand(undefined), timeoutPromise])
                        .then(() => {
                            eventBus.emit('command.trace', {
                                botId,
                                commandName,
                                sender,
                                remoteJid: msg?.key?.remoteJid,
                                status: 'success',
                            });
                        })
                        .catch(err => {
                            logger.error(`[CRASH PREVENTED][${isInstant ? 'INSTANT' : 'QUEUED'}] Error in ${commandName}: ${err.message}`);
                            eventBus.emit('command.trace', {
                                botId,
                                commandName,
                                sender,
                                remoteJid: msg?.key?.remoteJid,
                                status: 'error',
                                error: err?.message || String(err),
                            });
                            sendPremiumText(sock, msg.key.remoteJid, `❌ ${commandName} failed. Please retry.`).catch(() => {});
                        })
                        .finally(() => {
                            if (!isInstant) {
                                const cur = this._running.get(runKey) || 1;
                                if (cur <= 1) this._running.delete(runKey);
                                else this._running.set(runKey, cur - 1);
                            }
                        });
                };

                // Instant commands execute immediately without setImmediate delay
                // Also fast-track lightweight admin commands to reduce perceived lag
                const isLightweight = ['.kick', '.ban', '.warn', '.delete', '.dlt', '.promote', '.demote'].includes(commandName);
                if (isInstant || isLightweight) {
                    executeWithTimeout();
                } else {
                    // Heavy broadcast/status commands are queue-scheduled per node to protect responsiveness.
                    if (runtimeFlags.heavyCommandScheduler !== false && HEAVY_COMMANDS.has(commandName)) {
                        const scheduled = enqueueHeavyCommand({
                            botId,
                            commandName,
                            run: executeWithTimeout,
                        });
                        if (!scheduled.enqueued) {
                            sendPremiumText(sock, msg.key.remoteJid, `⏳ ${commandName} queue is full. Please retry shortly.`).catch(() => {});
                        }
                    } else {
                        // Other commands use setImmediate for non-blocking scheduling
                        setImmediate(executeWithTimeout);
                    }
                }

            } catch (error) {
                logger.error(`[CommandRouter] Dispatch Error: ${error.message}`);
            }
            } catch (outerErr) {
                logger.error(`[CommandRouter] OUTER CRASH PREVENTED: ${outerErr.message}`);
            }
        });
    }
}

module.exports = new CommandRouter();
