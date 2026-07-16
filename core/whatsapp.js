// core/whatsapp.js
// Ω ELITE CONNECTION MANAGER & EVENT-DRIVEN PROTOCOL

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    DisconnectReason,
    delay,
    Browsers
} = require('@crysnovax/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const { ownerTelegramId, ownerWhatsAppJids, globalPrefix } = require('../config');
const ownerManager = require('../modules/ownerManager');
const logger = require('./logger');
const engine = require('./engine'); 
const runtimeFlags = require('./runtimeFlags');
const { sendPremiumText } = require('./responseEngine');
const { rememberPreviewHint } = require('./linkPreview');
const { getYoutubeCookieArg } = require('./youtube');
const { generateAnimatedSticker, generateTelegramSticker } = require('./stickerEngine');
const { getKernel } = require('./runtimeKernel');
const { createAiEngine } = require('./aiEngine');
const pairingRegistry = require('../modules/pairingRegistry');
const watchdog = require('./watchdog');

const SESSIONS_PATH = path.join(__dirname, '../data/sessions');
const STATE_FILE = path.join(__dirname, '../data/botState.json');
const BANNED_ACCOUNTS_FILE = path.join(__dirname, '../data/wa-banned-accounts.json');

// Track 403 bans persistently across restarts with exponential backoff
let bannedAccounts = {};

function loadBannedAccounts() {
    fs.promises.readFile(BANNED_ACCOUNTS_FILE, 'utf8')
        .then((raw) => {
            try {
                bannedAccounts = JSON.parse(raw || '{}');
            } catch (e) {
                logger.warn('Failed to load banned accounts list', { error: e.message });
                bannedAccounts = {};
            }
        })
        .catch(() => { bannedAccounts = {}; });
}

function saveBannedAccounts() {
    fs.promises.mkdir(path.dirname(BANNED_ACCOUNTS_FILE), { recursive: true })
        .then(() => fs.promises.writeFile(BANNED_ACCOUNTS_FILE, JSON.stringify(bannedAccounts, null, 2), 'utf8'))
        .catch((e) => logger.warn('Failed to save banned accounts list', { error: e.message }));
}

function recordForbidden(phoneNumber) {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone) return;
    const entry = bannedAccounts[phone] || { firstSeenAt: Date.now(), failureCount: 0, lastFailureAt: Date.now() };
    entry.failureCount = (entry.failureCount || 0) + 1;
    entry.lastFailureAt = Date.now();
    bannedAccounts[phone] = entry;
    saveBannedAccounts();
    logger.warn(`[Ban Tracker] Phone +${phone} recorded 403 failure #${entry.failureCount}`);
}

function isBannedOrBackingOff(phoneNumber) {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone || !bannedAccounts[phone]) return false;
    
    const entry = bannedAccounts[phone];
    const failCount = entry.failureCount || 1;
    // Exponential backoff: 1min, 5min, 15min, 30min, 1hr, 4hr, 24hr
    const backoffMins = [1, 5, 15, 30, 60, 240, 1440];
    const backoffMs = backoffMins[Math.min(failCount - 1, backoffMins.length - 1)] * 60 * 1000;
    const timeSinceLastFailure = Date.now() - (entry.lastFailureAt || 0);
    
    return timeSinceLastFailure < backoffMs;
}

function getBackoffStatus(phoneNumber) {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone || !bannedAccounts[phone]) return null;
    
    const entry = bannedAccounts[phone];
    const failCount = entry.failureCount || 1;
    const backoffMins = [1, 5, 15, 30, 60, 240, 1440];
    const backoffMs = backoffMins[Math.min(failCount - 1, backoffMins.length - 1)] * 60 * 1000;
    const timeSinceLastFailure = Date.now() - (entry.lastFailureAt || 0);
    const msRemaining = Math.max(0, backoffMs - timeSinceLastFailure);
    const minsRemaining = Math.ceil(msRemaining / 60000);
    
    return {
        failureCount: failCount,
        backoffMinutes: backoffMins[Math.min(failCount - 1, backoffMins.length - 1)],
        minutesRemaining: minsRemaining,
        canRetry: msRemaining <= 0
    };
}

function clearBanRecord(phoneNumber) {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (phone && bannedAccounts[phone]) {
        delete bannedAccounts[phone];
        saveBannedAccounts();
        logger.info(`[Ban Tracker] Cleared ban record for +${phone}`);
    }
}

// Purge node-specific artifacts for a phone number (keeps shared link Intel untouched)
function purgeNodeArtifacts(phoneNumber, reason = 'unknown') {
    const phone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!phone) return;

    (async () => {
        try {
            const dataDir = path.join(__dirname, '../data');

            // Remove per-node state files
            const exactFiles = [
                getNodeStateFile(phone),
                getNodeStickerCmdsFile(phone),
                path.join(dataDir, `warmup-config-${phone}.json`),
                path.join(dataDir, `sudo-users-${phone}.json`),
            ];
            await Promise.all(exactFiles.map((fp) => fs.promises.unlink(fp).catch(() => {})));

            // Remove warmup media files for this phone with any extension
            try {
                const names = await fs.promises.readdir(dataDir).catch(() => []);
                const warmupFiles = names.filter((name) => name.startsWith(`warmup-media-${phone}.`));
                await Promise.all(warmupFiles.map((name) => fs.promises.unlink(path.join(dataDir, name)).catch(() => {})));
            } catch {}

            // Remove all session folders for this phone across all slots/chats
            const purgedSessionKeys = [];
            try {
                const sessionDirs = await fs.promises.readdir(SESSIONS_PATH).catch(() => []);
                const matches = sessionDirs.filter((name) => name.includes(`_${phone}_`));
                purgedSessionKeys.push(...matches);
                await Promise.all(matches.map((sessionName) => fs.promises.rm(path.join(SESSIONS_PATH, sessionName), { recursive: true, force: true }).catch(() => {})));
            } catch {}

            // Remove in-memory node state and caches for this phone
            try { nodeStates.delete(phone); } catch {}
            try { clearBanRecord(phone); } catch {}

            // Clean AI queues for all session keys belonging to this phone
            try {
                if (global._aiQueues) {
                    for (const key of Array.from(global._aiQueues.keys())) {
                        if (String(key).includes(`_${phone}_`)) global._aiQueues.delete(key);
                    }
                }
            } catch {}

            // Remove socket aliases and active socket entries for this phone
            try {
                if (global.waSockByBotId) {
                    for (const [key, sock] of global.waSockByBotId.entries()) {
                        if (String(key).replace(/[^0-9]/g, '') === phone) {
                            try { sock?.ws?.close?.(); } catch {}
                            global.waSockByBotId.delete(key);
                        }
                    }
                }
            } catch {}
            try {
                for (const sessionKey of purgedSessionKeys) {
                    activeSockets.delete(sessionKey);
                    kernel.socketManager?.remove?.(sessionKey);
                    kernel.reconnectManager?.state?.delete?.(sessionKey);
                    kernel.reconnectManager?.locks?.delete?.(sessionKey);
                    try { watchdog.detach(sessionKey); } catch {}
                }
            } catch {}

            // Remove per-node sudo from permissionEngine
            try {
                const pe = require('../modules/permissionEngine');
                const nodeSudos = pe.getNodeSudos(phone);
                for (const jid of nodeSudos) pe.removeNodeSudo(phone, jid);
            } catch {}

            // Drain and delete all BullMQ queue shards for this botId
            try {
                const { broadcastQueue } = require('./bullEngine');
                const shardSuffixes = ['godcast', 'gcast', 'status', 'default'];
                for (const suffix of shardSuffixes) {
                    const q = broadcastQueue._getShardByName?.(`${phone}-${suffix}`);
                    if (q) { await q.pause().catch(() => {}); await q.drain().catch(() => {}); await q.obliterate({ force: true }).catch(() => {}); }
                }
                // Also cancel any active campaign for this botId
                broadcastQueue._cancelCampaignsForBot?.(phone);
            } catch {}

            // Clear antiConfig cache entries for this botId's groups
            try {
                const antiConfig = require('./anti/antiConfig');
                for (const jid of antiConfig.getAllGroupJids()) {
                    // Only clear if the group was managed by this node (best-effort)
                    antiConfig.deleteGroupConfig(jid);
                }
            } catch {}

            // Clear rateLimiter entries for this botId
            try {
                const rl = require('../services/rateLimiter');
                rl.clearForBot?.(phone);
            } catch {}

            // Clear groupCache entries for this botId
            try {
                const gc = require('./groupCache');
                gc.clearForBot?.(phone);
            } catch {}
            try {
                const pr = require('../modules/pairingRegistry');
                const tgUserId = pr.getUserIdByPhone?.(phone);
                if (tgUserId) await pr.unregister(tgUserId).catch(() => {});
            } catch {}

            logger.system(`[Purge] Node +${phone} artifacts removed (${reason}) — link Intel preserved.`);
        } catch (err) {
            logger.warn(`[Purge] Failed to purge node +${phone}`, { error: err.message, reason });
        }
    })();
}

// Per-node state file — scoped by phone number so each node has isolated state
function getNodeStateFile(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return STATE_FILE;
    return path.join(__dirname, `../data/botState-${digits}.json`);
}

function getNodeStickerCmdsFile(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return path.join(__dirname, '../data/stickerCmds.json');
    return path.join(__dirname, `../data/stickerCmds-${digits}.json`);
}

const activeSockets = new Map();
const kernel = getKernel({ logger, engine });
if (!global.waSockByBotId) global.waSockByBotId = new Map();
// ─── GROUP METADATA CACHE (prevents WA 429 rate-limit errors) ───────────────
const groupCache = require('./groupCache');
const FORBIDDEN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const forbiddenAlertCache = new Map(); // sessionKey -> timestamp
const forbiddenAlertPhoneCache = new Map(); // phone -> timestamp
const MAX_PEER_SESSION_FILES = 500;

// Track decrypt failures per session — auto-prune signal files when they spike
const _decryptFailCount = new Map();
const _decryptPruneThrottle = new Map();
const HEARTBEAT_IDLE_MS = Number(process.env.WA_HEARTBEAT_IDLE_MS || 1200000); // 20min — gives godcast time to finish
const HEARTBEAT_INTERVAL_MS = Number(process.env.WA_HEARTBEAT_INTERVAL_MS || 30000);
const AI_MAX_QUEUE_SIZE = Number(process.env.WA_AI_MAX_QUEUE_SIZE || 6);
const AI_USER_COOLDOWN_MS = Number(process.env.WA_AI_USER_COOLDOWN_MS || 5000);

function trackDecryptFailure(sessionKey, sessionDir) {
    const count = (_decryptFailCount.get(sessionKey) || 0) + 1;
    _decryptFailCount.set(sessionKey, count);

    // After 10 failures, prune stale signal files — but throttle to once per 2 min
    if (count >= 10) {
        _decryptFailCount.set(sessionKey, 0);
        const lastPrune = _decryptPruneThrottle.get(sessionKey) || 0;
        if (Date.now() - lastPrune < 2 * 60 * 1000) return;
        _decryptPruneThrottle.set(sessionKey, Date.now());

        setImmediate(() => {
            (async () => {
                try {
                    const names = await fs.promises.readdir(sessionDir).catch(() => []);
                    const files = await Promise.all(
                        names
                            .filter((f) => f.startsWith('session-') || f.startsWith('sender-key-'))
                            .map(async (f) => ({ f, mt: (await fs.promises.stat(path.join(sessionDir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))
                    );
                    files.sort((a, b) => b.mt - a.mt);
                    if (files.length <= 250) return;
                    await Promise.all(files.slice(250).map(({ f }) => fs.promises.unlink(path.join(sessionDir, f)).catch(() => {})));
                    logger.info(`[WA] Auto-pruned ${files.length - 250} stale signal files for ${sessionKey} (decrypt spike)`);
                } catch {}
            })();
        });
    }
}

function prunePeerSessions(sessionDir, maxFiles = MAX_PEER_SESSION_FILES) {
    (async () => {
        try {
            const sessionFiles = (await fs.promises.readdir(sessionDir).catch(() => []))
                .filter((name) => name.startsWith('session-') && name.endsWith('.json'))
                .map((name) => {
                    const fullPath = path.join(sessionDir, name);
                    return fs.promises.stat(fullPath).then((stat) => ({ name, fullPath, mtimeMs: stat.mtimeMs })).catch(() => ({ name, fullPath, mtimeMs: 0 }));
                });
            const resolved = (await Promise.all(sessionFiles)).sort((a, b) => b.mtimeMs - a.mtimeMs);

            if (resolved.length <= maxFiles) return;
            const toDelete = resolved.slice(maxFiles);
            await Promise.all(toDelete.map((entry) => fs.promises.unlink(entry.fullPath).catch(() => {})));

            logger.warn(`[WA] Pruned peer sessions in ${path.basename(sessionDir)}: ${resolved.length} -> ${maxFiles}`);
        } catch (err) {
            logger.warn(`[WA] Failed to prune peer sessions: ${err.message}`);
        }
    })();
}

function getCachedAdminStatus(sock, jid, sender, extraCandidates) {
    // Fast path: check cache immediately
    const isAdmin = groupCache.isAdmin(jid, sender, sock, extraCandidates);
    
    // Background refresh: if socket is healthy AND cache miss/expired, warm up async
    if (!isAdmin && sock && jid && !jid.includes('@s.us')) {
        setImmediate(() => {
            groupCache.getGroupMeta(sock, jid).catch(() => {});
        });
    }
    
    return isAdmin;
}

function refreshGroupMeta(sock, jid) {
    if (!global._groupMetaRefreshThrottle) global._groupMetaRefreshThrottle = new Map();
    const botId = String(sock?.user?.id?.split(':')[0] || 'global');
    const key = `${botId}:${String(jid || '')}`;
    const now = Date.now();
    const state = global._groupMetaRefreshThrottle.get(key) || { lastAt: 0, inflight: false };

    // Avoid repeatedly fetching the same group metadata when the group is very active.
    // A stale cache is fine here; it only affects admin-status freshness, not message delivery.
    if (state.inflight || (now - state.lastAt) < 5 * 60 * 1000) return;

    state.inflight = true;
    state.lastAt = now;
    global._groupMetaRefreshThrottle.set(key, state);

    setImmediate(() => {
        groupCache.getGroupMeta(sock, jid)
            .catch(() => {})
            .finally(() => {
                state.inflight = false;
                state.lastAt = Date.now();
                global._groupMetaRefreshThrottle.set(key, state);
            });
    });
}

async function getCachedGroupMeta(sock, jid) {
    return groupCache.getGroupMeta(sock, jid);
}

// Resolve which poll option(s) a voter tapped.
// Incoming votes are ENCRYPTED (vote.encPayload/encIv). Decryption needs the poll's
// messageSecret (stored on the poll-creation message's messageContextInfo). The previous
// implementation passed a non-existent encKey arg to getAggregateVotesInPollMessage against
// a still-encrypted vote, so it always resolved to nothing and downloads never fired.
// ctx: { sock, pollMsgId, pollUpdateMessageKey, voterJid, pollCreatorJid, messageSecret }
async function resolveSongPollSelections(pollUpdate, cachedPoll, ctx = {}) {
    const pollMessage = cachedPoll?.message;
    if (!pollMessage) return [];

    let baileys = {};
    try { baileys = require('@crysnovax/baileys'); } catch {}
    const { getAggregateVotesInPollMessage, decryptPollVote, jidNormalizedUser } = baileys;

    const norm = (j) => {
        try { return (jidNormalizedUser && j) ? jidNormalizedUser(j) : j; } catch { return j; }
    };

    // The poll's encryption secret lives on the creation message (or is stashed in our lookup).
    const messageSecret =
        pollMessage?.messageContextInfo?.messageSecret
        || ctx.messageSecret
        || null;

    // 1) Get a DECRYPTED vote (selectedOptions = sha256 hashes of the chosen option names).
    //    Baileys auto-decrypts votes that arrive via messages.update (when getMessage finds the
    //    poll) — those already carry selectedOptions. Raw upsert votes must be decrypted here.
    let decryptedVote = pollUpdate?.vote || null;
    const looksDecrypted = Array.isArray(decryptedVote?.selectedOptions) && decryptedVote.selectedOptions.length > 0;

    if (!looksDecrypted && decryptedVote?.encPayload && typeof decryptPollVote === 'function' && messageSecret) {
        try {
            decryptedVote = decryptPollVote(pollUpdate.vote, {
                pollCreatorJid: norm(ctx.pollCreatorJid),
                pollMsgId: ctx.pollMsgId,
                pollEncKey: messageSecret,
                voterJid: norm(ctx.voterJid),
            });
        } catch { decryptedVote = null; }
    }

    // 2) Aggregate decrypted vote → option names (correct single-argument Baileys API).
    if (decryptedVote && typeof getAggregateVotesInPollMessage === 'function') {
        try {
            const votes = getAggregateVotesInPollMessage({
                message: pollMessage,
                pollUpdates: [{
                    pollUpdateMessageKey: ctx.pollUpdateMessageKey || pollUpdate?.pollUpdateMessageKey || null,
                    vote: decryptedVote,
                }],
            });
            const names = (votes || [])
                .filter((v) => Array.isArray(v?.voters) && v.voters.length > 0)
                .map((v) => String(v?.name || '').trim())
                .filter(Boolean);
            if (names.length) return names;
        } catch {}
    }

    // 3) Manual hash-match fallback (when selectedOptions are present but aggregation failed).
    const selectedHashes = decryptedVote?.selectedOptions || [];
    if (!selectedHashes.length) return [];
    const crypto = require('crypto');
    const pollOptions = pollMessage?.pollCreationMessageV3?.options || pollMessage?.pollCreationMessage?.options || [];
    const selectedNames = [];
    for (const option of pollOptions) {
        const optionName = String(option?.optionName || option?.name || '').trim();
        if (!optionName) continue;
        const optionHash = crypto.createHash('sha256').update(Buffer.from(optionName)).digest();
        const matches = selectedHashes.some((hash) => {
            const hashBuf = Buffer.isBuffer(hash) ? hash : Buffer.from(String(hash), 'base64');
            return hashBuf.equals(optionHash);
        });
        if (matches) selectedNames.push(optionName);
    }
    return selectedNames;
}

async function handleSongPollSelection(sock, groupJid, pollCreationId, selectedNames) {
    if (!groupJid || !pollCreationId || !selectedNames.length) return false;

    if (!global._handledSongPollVotes) global._handledSongPollVotes = new Set();
    const dedupKey = `${groupJid}:${pollCreationId}:${selectedNames.join('|')}`;
    if (global._handledSongPollVotes.has(dedupKey)) return true;
    global._handledSongPollVotes.add(dedupKey);
    setTimeout(() => global._handledSongPollVotes?.delete(dedupKey), 5 * 60 * 1000);

    const votedText = selectedNames.join(' ');
    const songTitle = String(selectedNames[0] || votedText).replace(/\s*\[.*?\]\s*$/, '').trim();
    if (!songTitle) return false;

    let cachedResult = null;

    const normalizedSelections = selectedNames
        .map((name) => String(name || '').replace(/\s*\[.*?\]\s*$/, '').trim().toLowerCase())
        .filter(Boolean);

    const pollLookup = global._songPollLookup?.get(pollCreationId);
    if (pollLookup?.jid === groupJid) {
        for (const sel of normalizedSelections) {
            const mapped = pollLookup.optionMap?.[sel];
            if (mapped?.videoId) {
                cachedResult = mapped;
                break;
            }
        }
    }

    if (global._songSearchCache?.size) {
        for (const [token, entry] of global._songSearchCache.entries()) {
            if (entry.jid !== groupJid) continue;
            const idx = entry.results.findIndex((r) => {
                const titleNorm = String(r?.title || '').replace(/\s*\[.*?\]\s*$/, '').trim().toLowerCase();
                const votedNorm = String(votedText || '').replace(/\s*\[.*?\]\s*$/, '').trim().toLowerCase();
                const ref = titleNorm.slice(0, 40);
                return titleNorm === votedNorm || votedNorm.includes(ref) || ref.includes(votedNorm.slice(0, 40));
            });
            if (idx === -1) continue;
            cachedResult = entry.results[idx];
            global._songSearchCache.delete(token);
            break;
        }
    }

    const statusMsg = await sock.sendMessage(groupJid, {
        text: `⏳ Got it! Downloading *${songTitle}*...\n🎵 Sending shortly`
    });

    try {
        const { downloadAudio, searchYoutube } = require('./youtube');

        let baseResult = cachedResult;
        if (!baseResult?.videoId) {
            const fresh = await searchYoutube(songTitle, 1);
            baseResult = fresh?.[0] || null;
        }
        if (!baseResult?.videoId) throw new Error('No result found for selected song');

        const candidates = [baseResult];
        try {
            const more = await searchYoutube(songTitle || baseResult.title || '', 5);
            for (const c of (more || [])) {
                if (!c?.videoId) continue;
                if (!candidates.some((x) => x?.videoId === c.videoId)) candidates.push(c);
            }
        } catch {}

        let dl = null;
        let picked = baseResult;
        let lastErr;
        for (const c of candidates) {
            if (!c?.videoId) continue;
            try {
                dl = await downloadAudio(c.videoId);
                picked = c;
                break;
            } catch (err) {
                lastErr = err;
            }
        }
        if (!dl) throw (lastErr || new Error('No downloadable candidate'));

        const ext = dl.fileExt || 'm4a';
        const mimetype = dl.mimetype || 'audio/mp4';
        const safeName = String(picked.title || songTitle || 'track').replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'track';
        await sock.sendMessage(groupJid, {
            audio: dl.buffer,
            mimetype,
            ptt: false,
            fileName: `${safeName}.${ext}`
        });
        await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
        return true;
    } catch (e) {
        await sock.sendMessage(groupJid, { text: `❌ Download failed: ${e.message.slice(0, 100)}` });
        await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
        return false;
    }
}

// 🧠 SaaS Fix: Expose this globally so bullEngine.js can find the sockets!
global.waSocks = activeSockets; 

// Per-node botState map: phone -> state object
const nodeStates = new Map();
// Global botState kept for backward compat (sleep, autoPair) — general owner only
let botState = { isSleeping: false, autoPairEnabled: true, pappyMode: {}, commandPrefix: globalPrefix };
if (!global.messageCache) global.messageCache = new Map();
if (!global._senderMsgIndex) global._senderMsgIndex = new Map();

if (!global._senderIndexCleanupStarted) {
    global._senderIndexCleanupStarted = true;
    // Clean stale sender index entries every 5 min
    setInterval(() => {
        if (!global._senderMsgIndex) return;
        for (const [key, ids] of global._senderMsgIndex.entries()) {
            for (const id of ids) {
                if (!global.messageCache?.has(id)) ids.delete(id);
            }
            if (ids.size === 0) global._senderMsgIndex.delete(key);
        }
    }, 5 * 60 * 1000).unref();

    // Scheduled signal file cleanup every 6 hours
    setInterval(() => {
        (async () => {
            try {
                const sessionsPath = path.join(__dirname, '../data/sessions');
                const dirs = await fs.promises.readdir(sessionsPath).catch(() => []);
                for (const d of dirs) {
                    const dir = path.join(sessionsPath, d);
                    try { if (!(await fs.promises.stat(dir)).isDirectory()) continue; } catch { continue; }
                    const files = await fs.promises.readdir(dir).catch(() => []);
                    const signalFiles = files.filter((f) => f.startsWith('session-') || f.startsWith('sender-key-'));
                    if (signalFiles.length <= 250) continue;
                    const sorted = (await Promise.all(signalFiles.map(async (f) => ({ f, mt: (await fs.promises.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))))
                        .sort((a, b) => b.mt - a.mt);
                    await Promise.all(sorted.slice(250).map(({ f }) => fs.promises.unlink(path.join(dir, f)).catch(() => {})));
                    logger.warn(`[WA] Scheduled prune: removed ${sorted.length - 250} signal files from ${d}`);
                }
            } catch {}
        })();
    }, 6 * 60 * 60 * 1000).unref();
}
if (!global._aiReplyCache) global._aiReplyCache = new Map();
if (!global.stickerCache) global.stickerCache = new Map();
const MAX_MESSAGE_CACHE_SIZE = 20000;

// ─── AI QUEUE & DEDUP (prevents duplicate AI calls per message) ────────────────
const fastq = require('fastq');
// Per-message dedup — ignore same msgId within 5s
const _aiMsgDedup = new Set();
// Global AI worker queue — processes one AI request at a time per bot session
if (!global._aiQueues) global._aiQueues = new Map();

function getAiQueue(sessionKey) {
    if (!global._aiQueues.has(sessionKey)) {
        // concurrency=1 per node — AI calls are heavy, never run more than 1 at a time
        // This prevents AI from starving command processing
        const q = fastq.promise(async (task) => {
            try { await task(); } catch {}
        }, 1);
        global._aiQueues.set(sessionKey, q);
    }
    return global._aiQueues.get(sessionKey);
}

function canAiReply(msgId) {
    // Dedup only — skip if same message already queued within 5s
    if (_aiMsgDedup.has(msgId)) return false;
    _aiMsgDedup.add(msgId);
    setTimeout(() => _aiMsgDedup.delete(msgId), 5000);
    return true;
}

function stopSocketHeartbeat(sessionKey) {
    if (!global._waHeartbeatTimers) global._waHeartbeatTimers = new Map();
    const timer = global._waHeartbeatTimers.get(sessionKey);
    if (timer) {
        clearInterval(timer);
        global._waHeartbeatTimers.delete(sessionKey);
    }
}

function bindSocketLiveness(sessionKey, sock) {
    if (!global._waWsLivenessHandlers) global._waWsLivenessHandlers = new Map();
    const ws = sock?.ws;
    if (!ws || typeof ws.on !== 'function') return;

    const touch = () => {
        if (!global._lastEventActivity) global._lastEventActivity = new Map();
        global._lastEventActivity.set(sessionKey, Date.now());
    };
    const onMessage = () => touch();
    const onPong = () => {
        sock._lastPongAt = Date.now();
        touch();
    };

    try {
        ws.on('message', onMessage);
        ws.on('pong', onPong);
        global._waWsLivenessHandlers.set(sessionKey, { ws, onMessage, onPong });
        sock._lastPongAt = Date.now();
        touch();
    } catch {}
}

function unbindSocketLiveness(sessionKey) {
    if (!global._waWsLivenessHandlers) return;
    const entry = global._waWsLivenessHandlers.get(sessionKey);
    if (!entry) return;

    try {
        entry.ws?.removeListener?.('message', entry.onMessage);
        entry.ws?.removeListener?.('pong', entry.onPong);
    } catch {}

    global._waWsLivenessHandlers.delete(sessionKey);
}

function startSocketHeartbeat(sessionKey, sock, reconnectFn) {
    if (!global._waHeartbeatTimers) global._waHeartbeatTimers = new Map();
    stopSocketHeartbeat(sessionKey);

    const timer = setInterval(() => {
        try {
            const liveSock = activeSockets.get(sessionKey);
            if (!liveSock || liveSock !== sock) return;

            const lastMsg = Number(global._lastMsgActivity?.get(sessionKey) || 0);
            const lastEvt = Number(global._lastEventActivity?.get(sessionKey) || 0);
            const last = Math.max(lastMsg, lastEvt, Number(sock._openedAt || 0));
            const idleMs = Date.now() - (last || Date.now());
            const sincePong = Date.now() - Number(sock._lastPongAt || 0);

            try { liveSock.ws?.ping?.(); } catch {}

            // Treat as zombie only if both event activity and pong responses are stale.
            if (
                idleMs > HEARTBEAT_IDLE_MS &&
                sincePong > (HEARTBEAT_INTERVAL_MS * 3) &&
                liveSock?.user &&
                liveSock.ws?.readyState === 1
            ) {
                logger.warn(`[Heartbeat] Zombie socket suspected for ${sessionKey} (idle ${Math.round(idleMs / 1000)}s) — refreshing socket`);
                try { liveSock.ev?.removeAllListeners?.(); } catch {}
                try { liveSock.ws?.close?.(); } catch {}
                stopSocketHeartbeat(sessionKey);
                reconnectFn();
            }
        } catch (err) {
            logger.warn(`[Heartbeat] ${sessionKey} check failed: ${err.message}`);
        }
    }, HEARTBEAT_INTERVAL_MS);

    timer.unref?.();
    global._waHeartbeatTimers.set(sessionKey, timer);
}

function teardownSocket(sessionKey, sock, reason = 'unknown') {
    if (global._groupInvalidateQueues?.has(sessionKey)) {
        const state = global._groupInvalidateQueues.get(sessionKey);
        if (state?.timer) clearTimeout(state.timer);
        global._groupInvalidateQueues.delete(sessionKey);
    }
    try { sock?.ev?.removeAllListeners?.(); } catch {}
    try { sock?.ws?.close?.(); } catch {}
    unbindSocketLiveness(sessionKey);
    stopSocketHeartbeat(sessionKey);
    kernel.presenceManager.stop(sessionKey);
    unbindSocketAliases(sock);
    activeSockets.delete(sessionKey);
    kernel.socketManager.remove(sessionKey);
    logger.info(`[WA] Socket teardown complete for ${sessionKey} (${reason})`);
}

function getNodeState(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return botState;
    if (!nodeStates.has(digits)) nodeStates.set(digits, { isSleeping: false, pappyMode: {}, commandPrefix: globalPrefix, nodeMode: 'public' });
    return nodeStates.get(digits);
}

function saveNodeState(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return;
    const state = nodeStates.get(digits);
    if (!state) return;
    fs.promises.writeFile(getNodeStateFile(digits), JSON.stringify(state)).catch(() => {});
}

function bindSocketAliases(sock, aliases = []) {
    if (!sock || !global.waSockByBotId) return;
    for (const alias of aliases) {
        const key = String(alias || '').trim();
        if (key) global.waSockByBotId.set(key, sock);
    }
}

function unbindSocketAliases(sock) {
    if (!sock || !global.waSockByBotId) return;
    for (const [key, value] of global.waSockByBotId.entries()) {
        if (value === sock) global.waSockByBotId.delete(key);
    }
}

const STICKER_CACHE_DIR = path.join(__dirname, '../data/sticker_cache');
const STICKER_CMDS_FILE = path.join(__dirname, '../data/stickerCmds.json');
let YT_DLP_BIN = 'yt-dlp';
fs.promises.access('/usr/local/bin/yt-dlp').then(() => { YT_DLP_BIN = '/usr/local/bin/yt-dlp'; }).catch(() => {});

async function refreshStickerCmdCache(phone) {
    const files = [STICKER_CMDS_FILE];
    const nodeFile = getNodeStickerCmdsFile(phone);
    if (nodeFile && nodeFile !== STICKER_CMDS_FILE) files.push(nodeFile);
    const merged = {};
    for (const file of files) {
        try {
            const parsed = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
            if (parsed && typeof parsed === 'object') Object.assign(merged, parsed);
        } catch {}
    }
    if (phone) {
        const digits = String(phone).replace(/[^0-9]/g, '');
        if (!global._stickerCmdsByNode) global._stickerCmdsByNode = new Map();
        global._stickerCmdsByNode.set(digits, merged);
    }
    global._stickerCmdsCache = { ...(global._stickerCmdsCache || {}), ...merged };
}

fs.promises.mkdir(STICKER_CACHE_DIR, { recursive: true }).catch(() => {});
fs.promises.mkdir(SESSIONS_PATH, { recursive: true }).catch(() => {});
fs.promises.mkdir(path.join(__dirname, '../data'), { recursive: true }).catch(() => {});
refreshStickerCmdCache().catch(() => {});
setInterval(() => refreshStickerCmdCache().catch(() => {}), 30000).unref();

const loadState = () => {
    fs.promises.readFile(STATE_FILE, 'utf-8')
        .then((raw) => {
            try {
                const parsed = JSON.parse(raw);
                botState = { pappyMode: {}, autoPairEnabled: true, commandPrefix: globalPrefix, ...parsed };
            } catch {
                botState = { isSleeping: false, autoPairEnabled: true, pappyMode: {}, commandPrefix: globalPrefix };
            }
        })
        .catch(() => {});
};
const saveState = () => fs.promises.writeFile(STATE_FILE, JSON.stringify(botState)).catch(() => {});
loadState();
loadBannedAccounts();

async function preloadNodeStates() {
    try {
        const dataDir = path.join(__dirname, '../data');
        const entries = await fs.promises.readdir(dataDir);
        const files = entries.filter((name) => /^botState-\d+\.json$/i.test(name));
        await Promise.all(files.map(async (name) => {
            const phone = name.match(/^botState-(\d+)\.json$/i)?.[1];
            if (!phone || nodeStates.has(phone)) return;
            try {
                const raw = await fs.promises.readFile(path.join(dataDir, name), 'utf8');
                const parsed = JSON.parse(raw);
                nodeStates.set(phone, { isSleeping: false, pappyMode: {}, commandPrefix: globalPrefix, nodeMode: 'public', ...parsed });
            } catch {}
        }));
    } catch {}
}
preloadNodeStates().catch(() => {});

const ownerWaSet = new Set((ownerWhatsAppJids || []).map((j) => String(j || '').trim()).filter(Boolean));
const ownerWaDigits = new Set(Array.from(ownerWaSet).map((j) => String(j || '').replace(/[^0-9]/g, '')).filter(Boolean));

// Global owner check — only the general owner JIDs from config
const isGlobalOwnerJid = (jid) => {
    const raw = String(jid || '').trim();
    const norm = raw.replace(/:\d+(?=@)/g, '');
    const phone = norm.replace(/[^0-9]/g, '');
    return ownerWaSet.has(raw) || ownerWaSet.has(norm) || ownerWaDigits.has(phone);
};

// Session-scoped owner check — general owner OR the specific phone that owns this session
// nodePhone = the phone number of this bot session (e.g. '2348164167112')
const isOwnerJidForSession = (jid, nodePhone) => {
    if (isGlobalOwnerJid(jid)) return true;
    if (!nodePhone) return false;
    const raw = String(jid || '').trim();
    const norm = raw.replace(/:\d+(?=@)/g, '');
    const phone = norm.replace(/[^0-9]/g, '');
    const nodeDigits = String(nodePhone || '').replace(/[^0-9]/g, '');
    return phone === nodeDigits;
};

// Legacy global isOwnerJid — kept for backward compat but only checks general owner
const isOwnerJid = isGlobalOwnerJid;

function getCommandPrefix(phone) {
    const state = phone ? getNodeState(phone) : botState;
    const prefix = String(state.commandPrefix || '').trim();
    return prefix || globalPrefix;
}

function setCommandPrefix(prefix, phone) {
    const clean = String(prefix || '').trim();
    if (!clean || clean.length > 3 || /\s/.test(clean)) return false;
    if (phone) {
        const state = getNodeState(phone);
        state.commandPrefix = clean;
        saveNodeState(phone);
    } else {
        botState.commandPrefix = clean;
        saveState();
    }
    return true;
}

// Node mode: 'public' = anyone can use cmds, 'private' = only node owner + general owner
function getNodeMode(phone) {
    return getNodeState(phone).nodeMode || 'public';
}

function setNodeMode(phone, mode) {
    const state = getNodeState(phone);
    state.nodeMode = mode === 'private' ? 'private' : 'public';
    saveNodeState(phone);
}

function normalizeCommandText(text, phone) {
    const raw = String(text || '').trimStart();
    if (!raw) return null;

    const activePrefix = getCommandPrefix(phone);
    const prefixes = [activePrefix];
    if (activePrefix !== globalPrefix) prefixes.push(globalPrefix);

    // Strict policy mode: only period-prefixed commands are accepted.
    if (runtimeFlags.strictPeriodPrefix) {
        return raw.startsWith(globalPrefix) ? raw : null;
    }

    for (const pfx of prefixes) {
        if (!raw.startsWith(pfx)) continue;
        const afterPrefix = raw.slice(pfx.length);
        // `. menu` — space(s) between prefix and cmd: collapse to `.menu args`
        const collapsed = `${globalPrefix}${afterPrefix.trimStart()}`;
        return collapsed;
    }

    // null prefix support: bare cmd like `menu` or `tag everyone`
    // only match if first word exactly matches a known cmd (without prefix)
    const firstWord = raw.split(/\s+/)[0].toLowerCase();
    if (firstWord && !firstWord.startsWith(globalPrefix)) {
        // check if `.firstWord` is a registered command by trying globalPrefix+firstWord
        const candidate = `${globalPrefix}${firstWord}`;
        // we can't access plugin registry here, so return candidate and let router drop unknown
        // but only do this when no prefix at all (not a sentence)
        // heuristic: if text is short (<=30 chars) and first word looks like a cmd word
        if (raw.length <= 60 && /^[a-z]{2,20}/.test(firstWord)) {
            return `${globalPrefix}${raw}`;
        }
    }

    return null;
}

function resolveSenderJid(msg, fallbackBotJid) {
    if (!msg?.key) return fallbackBotJid;
    if (msg.key.fromMe) return fallbackBotJid;

    const fromKey = msg.key.participant
        || msg.key.participantPn
        || msg.message?.extendedTextMessage?.contextInfo?.participant
        || msg.message?.imageMessage?.contextInfo?.participant
        || msg.message?.videoMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.videoMessage?.contextInfo?.participant
        || msg.key.remoteJid;

    return String(fromKey || '').trim();
}

// Alias used by the kernel dispatcher path
function extractSender(msg) {
    const jid = msg?.key?.remoteJid || '';
    const fallback = jid.endsWith('@g.us') ? '' : jid;
    return resolveSenderJid(msg, fallback);
}

/**
 * Initializes and manages a WhatsApp connection node.
 */
async function startWhatsApp(chatId = ownerTelegramId, phoneNumber, slotId = '1', isRestart = false, retryCount = 0, pairingUserId = null) {
    if (botState.isSleeping && !isRestart) return;

    // Check if account is in backoff period due to 403 bans (restart flows only)
    if (isRestart && isBannedOrBackingOff(phoneNumber)) {
        const backoffStatus = getBackoffStatus(phoneNumber);
        logger.info(`[Ban Backoff] Skipping +${phoneNumber} (failure #${backoffStatus.failureCount}, retry in ${backoffStatus.minutesRemaining}min)`);
        if (global.tgBot && retryCount === 0) { // Only notify once per startup
            global.tgBot.telegram.sendMessage(chatId,
                `⏳ <b>ACCOUNT IN RECOVERY</b>\nNode +${phoneNumber} is recovering from 403 ban.\n\n<b>Auto-retry in ${backoffStatus.minutesRemaining} minutes.</b>\n\nOr use /pair to re-link immediately.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
        return;
    }

    const sessionKey = `${chatId}_${phoneNumber}_${slotId}`;

    if (!global._kernelStarted) {
        global._kernelStarted = true;
        try { kernel.start(); } catch {}
    }

    if (!global._lastEventActivity) global._lastEventActivity = new Map();

    kernel.reconnectManager.setState(sessionKey, 'CONNECTING');
    if (activeSockets.has(sessionKey) && !isRestart) return;

    if (isRestart && activeSockets.has(sessionKey)) {
        const oldSock = activeSockets.get(sessionKey);
        if (oldSock) teardownSocket(sessionKey, oldSock, 'pre-reconnect-refresh');
    }

    const sessionDir = path.join(SESSIONS_PATH, sessionKey);
    // Do NOT prune before socket creation — deleting session files before connect
    // destroys signal keys needed for decryption, causing Bad MAC on all messages.
    // Pruning is handled after connection.update 'open' fires.
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let { version } = await fetchLatestBaileysVersion();
    if (!version) version = [2, 3000, 1017531287];


    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        
        // ─── CONNECTION STABILITY ───────────────────────────────────────
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 10000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 250,
        defaultQueryTimeoutMs: 60000,
        fireInitQueries: true,
        emitOwnEvents: false,
        transactionOpts: { maxCommitRetries: 3, delayBetweenTriesMs: 1000 },
        
        // Return cached message for retry decryption — fixes BAD MAC on restart
        getMessage: async (key) => {
            if (global.messageCache && key?.id) {
                const cached = global.messageCache.get(key.id);
                if (cached?.message) return cached.message;
            }
            return { conversation: '' };
        },
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
            if (requiresPatch) { 
                message = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...message } } };
            }
            return message;
        }
    });

    kernel.socketManager.register(sessionKey, sock);
    refreshStickerCmdCache(phoneNumber).catch(() => {});
    // 🔥 ENHANCE SOCKET WITH ALL FEATURES

    // 🔥 ENHANCE SOCKET WITH ALL FEATURES

    // ─── PAIRING CODE GENERATION ───
    // Only request pairing for fresh (unregistered) sessions that are not restarts.
    // PAIRING: fresh unregistered sessions only
    if (!sock?.authState?.creds?.registered && !isRestart) {
        clearBanRecord(phoneNumber);
        const cleanNumber = String(phoneNumber).replace(/[^0-9]/g, '');
        sock._pairingInProgress = true;

        let userLabel = 'PAPPYBOT';
        try {
            if (global.tgBot && chatId) {
                const u = await global.tgBot.telegram.getChat(chatId);
                if (u?.first_name) {
                    const clean = u.first_name.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8);
                    if (clean.length === 8) userLabel = clean;
                }
            }
        } catch {}

        logger.system(`[Pair] Initiating pairing for +${cleanNumber} — code: ${userLabel}`);

        setTimeout(async () => {
            try {
                let code;
                let lastErr;
                for (let attempt = 1; attempt <= 5; attempt++) {
                    try {
                        if (attempt > 1) await delay(3000 * attempt);
                        code = await sock.requestPairingCode(cleanNumber, userLabel);
                        if (code && typeof code === 'string') break;
                    } catch (e) {
                        lastErr = e;
                        const sc = e?.output?.statusCode;
                        logger.warn(`[Pair] Attempt ${attempt}/5: ${e.message} (${sc})`);
                        if (sc === 401 || sc === 403 || sc === 404) throw e;
                        if (attempt === 5) throw e;
                    }
                }
                if (!code) throw lastErr || new Error('No code returned');

                const display = `${code.slice(0,4)}-${code.slice(4)}`;
                sock._pairingCodeSent = true;
                sock._pairingCodeValue = display;
                sock._pairingCodeSentAt = Date.now();
                logger.system(`[Pair] Code for +${cleanNumber}: ${display}`);

                if (global.tgBot) {
                    const txt =
                        `🔗 <b>PAIRING CODE</b>\n\n` +
                        `📱 <code>+${cleanNumber}</code>\n\n` +
                        `<code>${display}</code>\n\n` +
                        `<i>WhatsApp → Linked Devices → Link with phone number</i>\n\n` +
                        `⏳ <b>Enter within 2 minutes!</b>`;
                    const targets = [chatId];
                    if (pairingUserId && pairingUserId !== chatId) targets.push(pairingUserId);
                    for (const t of targets) {
                        await global.tgBot.telegram.sendMessage(t, txt, { parse_mode: 'HTML' }).catch(() => {});
                    }
                }
            } catch (err) {
                if (sock._pairingCodeSent) return;
                const msg = String(err?.message || err);
                logger.error(`[Pair] Failed for +${cleanNumber}: ${msg}`);
                if (global.tgBot) {
                    global.tgBot.telegram.sendMessage(chatId,
                        `❌ <b>PAIRING FAILED</b>\n<code>${msg.slice(0,200)}</code>\n\nUse /pair to retry.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
            }
        }, 1500);
    }



    activeSockets.set(sessionKey, sock);
    bindSocketAliases(sock, [String(phoneNumber).replace(/[^0-9]/g, '')]);
    bindSocketLiveness(sessionKey, sock);
    try {
        watchdog.attach(sessionKey, sock, () => {
            kernel.reconnectManager.schedule(
                sessionKey,
                () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                'watchdog-zombie'
            );
        });
    } catch {}
    // Fix: Only setMaxListeners if available (Baileys update compatibility)
    if (typeof sock.ev.setMaxListeners === 'function') {
        sock.ev.setMaxListeners(20);
    }
    sock.ev.on('creds.update', saveCreds);

    // ─── CONNECTION HANDLING ───
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) sock._latestQr = qr;
        global._lastEventActivity.set(sessionKey, Date.now());

        if (connection === 'close') {
            kernel.socketManager.setState(sessionKey, 'DISCONNECTED');
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errMsg = String(lastDisconnect?.error?.message || '').toLowerCase();
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isBadMac = errMsg.includes('bad mac') || errMsg.includes('conflict') || statusCode === 401;
            const isRestartRequired = statusCode === DisconnectReason.restartRequired;
            const isForbidden = statusCode === 403;
            const isRateLimited = statusCode === 429;

            activeSockets.delete(sessionKey);
            unbindSocketLiveness(sessionKey);
            stopSocketHeartbeat(sessionKey);
            kernel.presenceManager.stop(sessionKey);
            unbindSocketAliases(sock);
            try { watchdog.detach(sessionKey); } catch {}

            if (isLoggedOut) {
                // During active pairing:
                //   • Code not yet sent → WA fired loggedOut before open; reconnect so pairing can complete.
                // During pairing, loggedOut before code sent = WA closed connection early, ignore and let normal reconnect handle it
                // During pairing, loggedOut after code sent = keep alive for 3 min so user can enter code
                if (sock._pairingInProgress) {
                    const timeSinceCode = Date.now() - (sock._pairingCodeSentAt || 0);
                    const keepAlive = 3 * 60 * 1000;
                    if (!sock._pairingCodeSent || timeSinceCode < keepAlive) {
                        logger.info(`[Pair] loggedOut during pairing — ignoring`);
                        return;
                    }
                }
                
                logger.system(`🚨 LOGGED OUT — purging session ${sessionKey}`);
                purgeNodeArtifacts(phoneNumber, 'logged-out');
                if (global.tgBot) {
                    global.tgBot.telegram.sendMessage(
                        chatId,
                        `🗑️ <b>SESSION PURGED</b>\nNode +${phoneNumber} was logged out and deleted. Re-pair to restore.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
                return;
            }

            // 403 = WhatsApp banned/blocked the session — stop retrying, notify owner
            if (isForbidden) {
                logger.system(`🚫 FORBIDDEN (403) — purging node artifacts for ${sessionKey}. Re-pair required.`);
                purgeNodeArtifacts(phoneNumber, 'forbidden-403');
                const phoneKey = String(phoneNumber || '').replace(/[^0-9]/g, '');
                const alertKey = phoneKey || sessionKey;
                const lastAlertAt = Number(forbiddenAlertPhoneCache.get(alertKey) || forbiddenAlertCache.get(sessionKey) || 0);
                const shouldAlert = Date.now() - lastAlertAt > FORBIDDEN_ALERT_COOLDOWN_MS;
                if (global.tgBot && shouldAlert) {
                    forbiddenAlertPhoneCache.set(alertKey, Date.now());
                    forbiddenAlertCache.set(sessionKey, Date.now());
                    global.tgBot.telegram.sendMessage(chatId,
                        `🚫 <b>CONNECTION FORBIDDEN (403)</b>\nNode +${phoneNumber} was rejected by WhatsApp.\nThe account may be temporarily or permanently banned.\n\n🗑️ Node session/state files were purged.\n\nUse /pair to re-link this number.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
                return; // stop — no more retries
            }

            // 429 = rate limited — back off longer before retrying
            if (isRateLimited) {
                const rateLimitDelay = 5 * 60 * 1000; // 5 minutes
                logger.system(`⏳ RATE LIMITED (429) — waiting 5 min before reconnecting ${sessionKey}...`);
                kernel.reconnectManager.schedule(
                    sessionKey,
                    () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                    { reason: 'rate-limit-429', delayMs: rateLimitDelay }
                );
                return;
            }

            if (isBadMac) {
                // Track bad MAC count per session in memory
                if (!global._badMacCount) global._badMacCount = new Map();
                const badMacCount = (global._badMacCount.get(sessionKey) || 0) + 1;
                global._badMacCount.set(sessionKey, badMacCount);

                logger.system(`⚠️ BAD MAC (${badMacCount}) for ${sessionKey}`);
                const dir = path.join(SESSIONS_PATH, sessionKey);

                // After 5 consecutive bad MACs — full wipe + notify, stop the loop
                if (badMacCount >= 5) {
                    global._badMacCount.delete(sessionKey);
                    logger.system(`🚨 BAD MAC loop — full wipe for ${sessionKey}, re-pair required`);
                    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
                    if (global.tgBot) {
                        global.tgBot.telegram.sendMessage(chatId,
                            `⚠️ <b>SESSION RESET</b>\nNode +${phoneNumber} hit repeated BAD MAC errors and was wiped.\nUse /pair to re-link.`,
                            { parse_mode: 'HTML' }
                        ).catch(() => {});
                    }
                    return;
                }

                // First 2 bad MACs — just reconnect without wiping, might be a transient error
                if (badMacCount <= 2) {
                    const backoff = 10000 + Math.floor(Math.random() * 5000);
                    logger.system(`[WA] Soft reconnect for ${sessionKey} in ${Math.round(backoff/1000)}s (bad MAC ${badMacCount}/5)`);
                    kernel.reconnectManager.schedule(
                        sessionKey,
                        () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                        { reason: 'bad-mac-soft', delayMs: backoff }
                    );
                    return;
                }

                // 3rd-4th bad MAC — wipe signal files but keep creds + app-state
                try {
                    if (fs.existsSync(dir)) {
                        prunePeerSessions(dir, MAX_PEER_SESSION_FILES);
                        const files = fs.readdirSync(dir);
                        for (const f of files) {
                            if (f === 'creds.json' || f === 'connected.flag') continue;
                            if (f.startsWith('app-state')) continue;
                            try { fs.unlinkSync(path.join(dir, f)); } catch {}
                        }
                    }
                } catch {}

                if (global.messageCache) global.messageCache.clear();
                if (global._senderMsgIndex) global._senderMsgIndex.clear();

                const backoff = Math.min(20000 * Math.pow(2, badMacCount - 3), 60000) + Math.floor(Math.random() * 5000);
                logger.system(`[WA] Reconnecting ${sessionKey} in ${Math.round(backoff/1000)}s after signal wipe (bad MAC ${badMacCount}/5)`);
                kernel.reconnectManager.schedule(
                    sessionKey,
                    () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                    { reason: 'bad-mac-signal-wipe', delayMs: backoff }
                );
                return;
            }

            // ── PAIRING: 428 while code is active — normal WA behaviour, use standard reconnect
            // socket.js patched to send registrationNode even when creds.me is set but !registered
            if (sock._pairingInProgress && sock._pairingCodeSent) {
                const timeSinceCode = Date.now() - (sock._pairingCodeSentAt || 0);
                if (timeSinceCode < 3 * 60 * 1000) {
                    logger.info(`[Pair] Socket closed (${statusCode}) — normal during pairing, reconnecting`);
                    kernel.reconnectManager.schedule(
                        sessionKey,
                        () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                        { reason: 'pairing-reconnect', delayMs: 2000 }
                    );
                    return;
                }
            }

            // Exponential backoff with jitter: 3s → 6s → 12s → … capped at 60s
            const baseDelay = isRestartRequired ? 1500 : 3000;
            const jitter = Math.floor(Math.random() * 1500);
            const reconnectDelay = Math.min(baseDelay * Math.pow(2, Math.min(retryCount, 4)), 60000) + jitter;
            logger.system(`Connection closed (code ${statusCode}). Reconnecting ${sessionKey} in ${Math.round(reconnectDelay / 1000)}s (attempt ${retryCount + 1})...`);
            kernel.reconnectManager.schedule(
                sessionKey,
                () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                `close-${statusCode || 'unknown'}`
            );
        }
        
        if (connection === 'open') {
            kernel.socketManager.setState(sessionKey, 'OPEN');
            kernel.reconnectManager.markOpen(sessionKey);
            sock._openedAt = Date.now();
            const connectedBotId = sock.user?.id?.split(':')[0];
            bindSocketAliases(sock, [connectedBotId, String(phoneNumber).replace(/[^0-9]/g, '')]);
            retryCount = 0;
            if (global._badMacCount) global._badMacCount.delete(sessionKey);
            logger.success(`🟩 WhatsApp Online → ${phoneNumber}`);


            // Auto-prune signal files — only on first connect per session, not on every reconnect
            if (!global._prunedSessions) global._prunedSessions = new Set();
            if (!global._prunedSessions.has(sessionKey)) {
                global._prunedSessions.add(sessionKey);
                setImmediate(async () => {
                    try {
                        const dir = path.join(SESSIONS_PATH, sessionKey);
                        if (!fs.existsSync(dir)) return;
                        const files = await fs.promises.readdir(dir);
                        const sessionFiles = files.filter(f => f.startsWith('session-') || f.startsWith('sender-key-'));
                        if (sessionFiles.length <= 250) return;
                        const withMtime = await Promise.all(
                            sessionFiles.map(async f => ({ f, mt: (await fs.promises.stat(path.join(dir, f))).mtimeMs }))
                        );
                        withMtime.sort((a, b) => b.mt - a.mt);
                        await Promise.all(withMtime.slice(250).map(({ f }) => fs.promises.unlink(path.join(dir, f)).catch(() => {})));
                        logger.warn(`[WA] Pruned ${withMtime.length - 250} stale signal files for ${sessionKey}`);
                    } catch {}
                });
            }
            prunePeerSessions(path.join(SESSIONS_PATH, sessionKey), MAX_PEER_SESSION_FILES);
            engine.triggerBoot(sock);
            require('./eventBus').emit('socket.open', sock);

            // Pre-warm group metadata cache via shared groupCache module
            groupCache.warmUp(sock);

            startSocketHeartbeat(sessionKey, sock, () => {
                kernel.reconnectManager.schedule(
                    sessionKey,
                    () => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1),
                    'heartbeat-stale'
                );
            });

            // --- BEGIN: Send one-time CONNECTED message after pairing ---
            const stateFile = path.join(SESSIONS_PATH, sessionKey, 'connected.flag');
            try {
                await fs.promises.access(stateFile);
            } catch {
                fs.promises.writeFile(stateFile, 'connected').catch(() => {}); // write flag FIRST before any async ops
                if (global.tgBot) {
                    // Main connected message with node inline button + user guide
                    global.tgBot.telegram.sendMessage(
                        chatId,
                        `✅ <b>WHATSAPP CONNECTED!</b>\n\n📱 <code>+${phoneNumber}</code> is now live and paired.\n\n<b>What you can do now:</b>\n• Send <code>.menu</code> in any WhatsApp chat\n• Send <code>.pappy on</code> in a group to enable AI\n• Say <b>pappy</b> anywhere to trigger AI instantly\n• Use <code>.play</code>, <code>.sticker</code>, <code>.img</code> and more\n\n<pre>┏━━━━━━━━━━━━━━━━━━━━━━┓\n┃  🟢  CONNECTED!      ┃\n┗━━━━━━━━━━━━━━━━━━━━━━┛</pre>`,
                        {
                            parse_mode: 'HTML',
                            disable_web_page_preview: true,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `📱 Manage Node +${phoneNumber}`, callback_data: `node_${sessionKey}` }],
                                    [{ text: '📖 User Guide', callback_data: 'cmd_guide' }, { text: '🏠 Main Hub', callback_data: 'menu_main' }],
                                ]
                            }
                        }
                    ).catch(() => {});

                    // AI greeting message — sent separately so it feels natural
                    setTimeout(() => {
                        global.tgBot.telegram.sendMessage(
                            chatId,
                            `🤖 <b>Hey! I'm Pappy.</b>\n\nIf you're ever confused or need help, just call me — say <b>pappy</b> anywhere in your WhatsApp chat and I'll respond. No need to turn anything on.\n\n<i>You can also do <code>.pappy on</code> in a group to keep me active there all the time.</i>`,
                            { parse_mode: 'HTML' }
                        ).catch(() => {});
                    }, 1500);
                }
            }
            // --- END: CONNECTED message ---
        }
    });

    // ─── MESSAGE EVENT ROUTING ───
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Update last activity timestamp for self-healing
        if (!global._lastMsgActivity) global._lastMsgActivity = new Map();
        global._lastMsgActivity.set(sessionKey, Date.now());
        global._lastEventActivity.set(sessionKey, Date.now());

        // Dispatcher-first routing: keep the hot path lightweight.
        try {
            const botIdNow = sock.user?.id?.split(':')[0] || phoneNumber;
            for (const m of (messages || [])) {
                const jid = m?.key?.remoteJid;
                if (!jid) continue;
                const text =
                    m.message?.conversation
                    || m.message?.extendedTextMessage?.text
                    || m.message?.imageMessage?.caption
                    || m.message?.videoMessage?.caption
                    || '';
                const sender = extractSender(m);
                const isGroup = jid.endsWith('@g.us');
                const ctx = {
                    sock,
                    msg: m,
                    jid,
                    text,
                    sender,
                    isGroup,
                    botId: botIdNow,
                    isGroupAdmin: false,
                    flags: {},
                };
                kernel.messageRouter.dispatch(ctx).catch(() => {});
            }

            // Command-first reliability: when a batch is command-only, skip legacy heavy pipeline.
            const hasNonCommand = (messages || []).some((m) => {
                const t = (
                    m?.message?.conversation
                    || m?.message?.extendedTextMessage?.text
                    || m?.message?.imageMessage?.caption
                    || m?.message?.videoMessage?.caption
                    || ''
                ).trim();
                return !!t && !normalizeCommandText(t, phoneNumber);
            });
            if (!hasNonCommand) return;

            if (String(process.env.WA_ROUTER_ONLY || '').toLowerCase() === 'true') {
                return;
            }
        } catch {}

        // ── POLL VOTE DETECTION for .song ──────────────────────────────────────
        for (const m of messages) {
            try {
                if (!m.message?.pollUpdateMessage) continue;
                const groupJid = m.key?.remoteJid;
                if (!groupJid) continue;

                // Get the poll creation message to read option names
                const pollCreationKey = m.message.pollUpdateMessage.pollCreationMessageKey?.id;
                const cachedPoll = global.messageCache?.get(pollCreationKey);
                if (!cachedPoll) continue;
                const pollName = cachedPoll?.message?.pollCreationMessageV3?.name || cachedPoll?.message?.pollCreationMessage?.name || '';
                if (!pollName.includes('Pick a track') && !pollName.includes('Pick a song')) continue;

                const voterJid = m.key?.participant || m.key?.remoteJid;
                const selectedNames = (await resolveSongPollSelections(m.message.pollUpdateMessage, cachedPoll, {
                    sock,
                    pollMsgId: pollCreationKey,
                    pollUpdateMessageKey: m.key,
                    voterJid,
                    pollCreatorJid: sock.user?.id,
                    messageSecret: global._songPollLookup?.get(pollCreationKey)?.messageSecret,
                }))
                    .map((name) => String(name || '').replace(/\s*\[.*?\]\s*$/, '').trim())
                    .filter(Boolean);
                if (!selectedNames.length) continue;

                await handleSongPollSelection(sock, groupJid, pollCreationKey || m.key?.id || '', selectedNames);
            } catch (e) {
                logger.warn(`[Poll] Error: ${e.message}`);
            }
        }

                try {
        if (botState.isSleeping || (type !== 'notify' && type !== 'append')) return;
        
        const msg = messages[0];
        if (!msg?.message) return;
        const _rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        // Only log messages that have actual text content
        if (_rawText) logger.info(`[MSG] type=${type} fromMe=${msg.key?.fromMe} text=${_rawText.slice(0,40)}`);

        // Cache ALL messages in the batch (not just index 0) so deleteall can find bot-sent audio/songs
        for (const m of messages) {
            if (m?.key?.id && m?.message) {
                global.messageCache.set(m.key.id, m);
                while (global.messageCache.size > MAX_MESSAGE_CACHE_SIZE) {
                    const oldest = global.messageCache.keys().next().value;
                    if (!oldest) break;
                    global.messageCache.delete(oldest);
                }
                // Index by sender for fast deleteall lookup. WA can report a group
                // participant as either a LID ("...@lid") or a phone-number JID
                // ("...@s.whatsapp.net") depending on the message/group, and the two
                // don't share digits — so we index under EVERY form we have for this
                // message's sender. Without this, deleteall would silently miss every
                // message whose participant form didn't match the tag's form.
                const groupJid = m.key?.remoteJid;
                if (groupJid) {
                    const senderDigitForms = new Set();
                    if (m.key?.fromMe) {
                        const d = String(phoneNumber || '').replace(/[^0-9]/g, '');
                        if (d) senderDigitForms.add(d);
                    } else {
                        const d1 = String(m.key?.participant || '').replace(/[^0-9]/g, '');
                        const d2 = String(m.key?.participantPn || '').replace(/[^0-9]/g, '');
                        if (d1) senderDigitForms.add(d1);
                        if (d2) senderDigitForms.add(d2);
                    }
                    for (const senderDigits of senderDigitForms) {
                        const indexKey = `${groupJid}:${senderDigits}`;
                        if (!global._senderMsgIndex.has(indexKey)) global._senderMsgIndex.set(indexKey, new Set());
                        global._senderMsgIndex.get(indexKey).add(m.key.id);
                    }
                }
            }
        }

        const jid = msg.key.remoteJid;
        if (!jid) return; // guard null JID — prevents jidDecode crash
        const isGroup = jid.endsWith('@g.us');
        
        const botId = sock.user?.id?.split(':')[0] || phoneNumber;
        const fullBotJid = `${botId}@s.whatsapp.net`;
        const nodeState = getNodeState(phoneNumber);
        const nodeMode = nodeState.nodeMode || 'public';
        
        let text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            msg.message?.documentMessage?.caption ||
            msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title ||
            msg.message?.templateButtonReplyMessage?.selectedDisplayText ||
            msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
            msg.message?.ephemeralMessage?.message?.conversation ||
            msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
            msg.message?.ephemeralMessage?.message?.imageMessage?.caption ||
            msg.message?.ephemeralMessage?.message?.videoMessage?.caption ||
            msg.message?.viewOnceMessage?.message?.imageMessage?.caption ||
            msg.message?.viewOnceMessage?.message?.videoMessage?.caption ||
            ''
        ).trim();

        // Learn rich preview cards users send so later status/godcast can reuse them.
        const directCtx = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo;
        const ephCtx = msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.videoMessage?.contextInfo;
        const observedCtx = directCtx || ephCtx;
        if (observedCtx?.externalAdReply) {
            // Tier 1 of the status-preview resolver: remember the exact card the user's
            // WhatsApp generated for this link so .updategstatus / .godcast / .gcast can
            // reuse it verbatim later (consumed via getPreviewHintAsync in core/statusPreview.js).
            rememberPreviewHint(text, observedCtx);
        }

        // Check if this is actually a sticker message (not text)
        const isActualSticker = !!(msg.message?.stickerMessage);
        
        // If it's a sticker, don't treat it as text
        if (isActualSticker) {
            text = ''; // Clear text so it doesn't trigger text responses
        }

        const sender = msg.key.fromMe ? fullBotJid : resolveSenderJid(msg, fullBotJid);
        // Pass every JID form we know about for this sender — WA sometimes reports the
        // participant as a LID and sometimes as a phone-number JID, and the group's
        // participants list may not use the same form `sender` ended up resolving to.
        const senderJidCandidates = [msg.key.participant, msg.key.participantPn].filter(Boolean);
        const botJidCandidates = [sock.user?.lid].filter(Boolean);
        let isGroupAdmin = isGroup ? getCachedAdminStatus(sock, jid, sender, senderJidCandidates) : false;
        let botIsGroupAdmin = isGroup ? getCachedAdminStatus(sock, jid, fullBotJid, botJidCandidates) : false;

        // Private mode: only node owner + general owner + registered node owners can interact at all
        if (nodeMode === 'private' && !msg.key.fromMe && !isOwnerJidForSession(sender, phoneNumber) && !ownerManager.isOwner(sender)) {
            return;
        }

        // Hard DM policy: only the general owner, this session's own number, OR a registered node owner can interact in DM
        if (!isGroup && !msg.key.fromMe && !isOwnerJidForSession(sender, phoneNumber) && !ownerManager.isOwner(sender)) {
            return;
        }

        // ── STICKER TRIGGER HANDLER ──────────────────────────────────────────
        let isStickerTriggered = false;
        if (msg.message?.stickerMessage && !text) {
            try {
                const sticker = msg.message.stickerMessage;
                // Handle all fileSha256 formats (Buffer, {type,data}, base64 string)
                let stickerId = null;
                const sha = sticker.fileSha256;
                if (sha) {
                    if (Buffer.isBuffer(sha)) stickerId = sha.toString('base64');
                    else if (sha?.type === 'Buffer' && Array.isArray(sha?.data)) stickerId = Buffer.from(sha.data).toString('base64');
                    else if (typeof sha === 'string') stickerId = sha;
                    else stickerId = Buffer.from(sha).toString('base64');
                }
                if (stickerId) {
                    const nodeDigits = String(phoneNumber || botId || '').replace(/[^0-9]/g, '');
                    const nodeCache = global._stickerCmdsByNode?.get(nodeDigits) || {};
                    const boundCmd = nodeCache[stickerId] || global._stickerCmdsCache[stickerId];
                    if (boundCmd) {
                        text = boundCmd;
                        isStickerTriggered = true;
                        // Preserve original message structure so commands like .tag work with context
                        // Only replace conversation, keep contextInfo intact
                        const origCtxInfo = msg.message?.stickerMessage?.contextInfo || null;
                        msg.message = {
                            extendedTextMessage: {
                                text: boundCmd,
                                linkPreviewFetchDisabled: true,
                                contextInfo: origCtxInfo || {}
                            }
                        };
                        logger.info(`[Sticker Trigger] Fired: ${boundCmd}`);
                    }
                }
            } catch (e) {
                logger.error(`[Sticker Trigger] Error: ${e.message}`);
            }
        }

        // Only refresh group meta if cache is stale — don't block on every message
        if (isGroup) refreshGroupMeta(sock, jid);

        // ── SONG PICK HANDLER — user replies with number after .song search ────────────────
        if (text && /^[1-5]$/.test(text.trim()) && global._songSearchCache?.size > 0) {
            const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            for (const [token, entry] of global._songSearchCache.entries()) {
                if (entry.jid === jid) {
                    const pick = parseInt(text.trim()) - 1;
                    const result = entry.results?.[pick];
                    if (result) {
                        global._songSearchCache.delete(token);
                        const statusMsg = await sock.sendMessage(jid, { text: `🎵 *${result.title}*\n⏳ Downloading...` }, { quoted: msg });
                        try {
                            const { exec } = require('child_process');
                            const util = require('util');
                            const execAsync = util.promisify(exec);
                            const fsp = require('fs').promises;
                            const tmpDir = path.join(__dirname, '../data/temp_media');
                            await fsp.mkdir(tmpDir, { recursive: true });
                            const outPath = path.join(tmpDir, `song_${Date.now()}.mp3`);
                            const cookieArg = getYoutubeCookieArg();
                            await execAsync(`${YT_DLP_BIN} ${cookieArg} -x --audio-format mp3 --audio-quality 2 --max-filesize 48m --no-playlist --no-warnings -o "${outPath}" "${result.url}"`, { timeout: 120000 });
                            let fileReady = true;
                            try { await fsp.access(outPath); } catch { fileReady = false; }
                            if (fileReady) {
                                const buf = await fsp.readFile(outPath);
                                await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `${result.title}.mp3` }, { quoted: msg });
                                fsp.unlink(outPath).catch(() => {});
                                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
                            }
                        } catch (e) {
                            await sendPremiumText(sock, jid, `❌ Download failed: ${e.message}`, { quoted: msg });
                        }
                    }
                    break;
                }
            }
        }

        const normalizedCommandText = normalizeCommandText(text, phoneNumber);
        // Handle "next" reply to song info message
        const quotedMsgText = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || '';
        const isNextReply = text?.trim().toLowerCase() === 'next' && quotedMsgText.includes('Tap your choice above');
        const isCommandMessage = !!normalizedCommandText || isNextReply;
        if (isNextReply && !normalizedCommandText) {
            // Treat as .song next [query]
            const songQuery = quotedMsgText.match(/Pick a song: (.+)/)?.[1] || '';
            if (songQuery) {
                engine.triggerMessage({ sock, msg, text: `.song next ${songQuery}`, isGroup, sender, botId, isGroupAdmin, botIsGroupAdmin });
                return;
            }
        }
        if (isCommandMessage) {
            engine.triggerMessage({
                sock,
                msg,
            text: normalizedCommandText,
                isGroup,
                sender,
                botId,
                isGroupAdmin,
                botIsGroupAdmin,
                resolveIsGroupAdmin: async () => {
                    if (!isGroup) return false;
                    const meta = await getCachedGroupMeta(sock, jid);
                    return groupCache.isAdminInMeta(meta, [sender, msg.key.participant, msg.key.participantPn]);
                },
                resolveBotIsGroupAdmin: async () => {
                    if (!isGroup) return false;
                    const meta = await getCachedGroupMeta(sock, jid);
                    return groupCache.isAdminInMeta(meta, [fullBotJid, sock.user?.lid]);
                }
            });
            return;
        }

        // ─── AI context — check all message types for reply context ────────
        // WA puts contextInfo in different places depending on message type
        const ctxInfo = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo
            || msg.message?.audioMessage?.contextInfo
            || msg.message?.documentMessage?.contextInfo
            || msg.message?.stickerMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo
            || null;
        const mentionedJids     = ctxInfo?.mentionedJid || [];
        const isMentioned       = mentionedJids.some(j => j.startsWith(botId));
        const quotedParticipant = ctxInfo?.participant;
        const quotedStanzaId    = ctxInfo?.stanzaId;
        const cachedMsg         = quotedStanzaId ? global.messageCache.get(quotedStanzaId) : null;
        const botDigits         = String(botId).replace(/[^0-9]/g, '');
        const quotedDigits      = String(quotedParticipant || '').replace(/[^0-9]/g, '');
        const isReplyToBot = !!(
            quotedParticipant?.startsWith(botId) ||
            (quotedDigits && quotedDigits === botDigits) ||
            cachedMsg?.key?.fromMe ||
            ctxInfo?.quotedMessage?.key?.fromMe
        );
        const hasImage          = !!(msg.message?.imageMessage);
        const hasVoice          = !!(msg.message?.audioMessage?.ptt);
        const hasSticker        = !!(msg.message?.stickerMessage);
        // Quoted image — user replied to an image with text like "make sticker" or "describe"
        const quotedImageMsg    = ctxInfo?.quotedMessage?.imageMessage || ctxInfo?.quotedMessage?.ephemeralMessage?.message?.imageMessage;
        const hasQuotedImage    = !!(quotedImageMsg) && !hasImage;
        const unifiedAi = createAiEngine(String(chatId));
        const pappyOn = isGroup
            ? await unifiedAi.isGroupEnabled(jid).catch(() => nodeState.pappyMode?.[jid] === true)
            : false;
        
        // Debug: log when sticker is detected
        if (hasSticker && pappyOn && isGroup) {
            logger.info(`[STICKER] Detected sticker message from ${sender}`);
        }

        // Sticker reply-to-bot detection
        const stickerCtxInfo = msg.message?.stickerMessage?.contextInfo;
        const stickerCachedMsg = stickerCtxInfo?.stanzaId ? global.messageCache.get(stickerCtxInfo.stanzaId) : null;
        const isStickerReplyToBot = !!(stickerCtxInfo?.participant?.startsWith(botId)) || !!(stickerCachedMsg?.key?.fromMe);

        // Explicit mention/reply triggers always work in groups.
        // Keyword trigger "pappy" follows .pappy mode state so OFF truly disables it.
        const hasPappyTrigger = pappyOn && !msg.key.fromMe && /\bpappy\b/i.test(text);
        // Group AI must respect .pappy on/off strictly. If OFF, do not answer ambient or explicit AI triggers.
        const explicitGroupTrigger = pappyOn && (isMentioned || isReplyToBot || isStickerReplyToBot || hasPappyTrigger);
        const ambientGroupTrigger = pappyOn && (hasSticker || !!String(text || '').trim());

        const shouldRespond = !msg.key.fromMe && (
            (isGroup && (explicitGroupTrigger || ambientGroupTrigger)) ||
            (!isGroup && isOwnerJidForSession(sender, phoneNumber))
        );
        
        if (shouldRespond && !text.startsWith(globalPrefix)) {
            const msgId = msg.key.id || '';
            const senderCooldownKey = `${sessionKey}:${String(sender || '').replace(/:\d+(?=@)/g, '')}`;
            if (!global._aiUserCooldown) global._aiUserCooldown = new Map();
            const lastUserAiAt = Number(global._aiUserCooldown.get(senderCooldownKey) || 0);
            if (Date.now() - lastUserAiAt < AI_USER_COOLDOWN_MS) return;
            global._aiUserCooldown.set(senderCooldownKey, Date.now());

            // Dedup check — skip if same message already queued
            if (!canAiReply(msgId)) return;

            const { downloadMediaMessage } = require('@crysnovax/baileys');
            const ai = require('./ai');
            sock.sendPresenceUpdate('composing', jid).catch(() => {});
            logger.info(`[AI] Queued - Sticker: ${hasSticker}, Mentioned: ${isMentioned}, Reply: ${isReplyToBot}`);

            // Push into per-session queue — 1 AI call at a time per node
            // If queue is backed up, drop this request to protect command responsiveness.
            const aiQ = getAiQueue(sessionKey);
            if (aiQ.length() >= AI_MAX_QUEUE_SIZE) {
                logger.warn(`[AI] Queue overloaded for ${sessionKey} (${aiQ.length()}) — dropping new AI task`);
                return;
            }
            aiQ.push(async () => {
                try {
                    let response = '';

                if (hasSticker) {
                    // User sent sticker - reply with STICKER ONLY (no text)
                    
                    const stickerPrompts = [
                        'cool anime guy character with glowing aura aesthetic',
                        'powerful anime male warrior energy aura',
                        'aesthetic anime boy character epic vibe',
                        'anime male character legendary pose glowing',
                        'sigma anime guy energy aesthetic',
                        'anime male protagonist power up aura glowing',
                        'epic anime guy power up scene glowing energy',
                        'legendary anime male character aesthetic pose',
                        'anime guy with cosmic aura background',
                        'cool anime girl character with glowing aura aesthetic',
                        'powerful anime female warrior energy aura',
                        'aesthetic anime girl character epic vibe',
                        'anime female character legendary pose glowing',
                        'anime girl protagonist power up aura glowing'
                    ];
                    
                    const randomPrompt = stickerPrompts[Math.floor(Math.random() * stickerPrompts.length)];
                    const cacheKey = Buffer.from(randomPrompt).toString('base64').slice(0, 20);
                    
                    // Send sticker only (no text)
                    try {
                        let stickerBuffer;
                        
                        if (global.stickerCache.has(cacheKey)) {
                            stickerBuffer = global.stickerCache.get(cacheKey);
                        } else {
                            const imgBuffer = await Promise.race([
                                ai.generateImage(randomPrompt),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                            ]);

                            const generated = await generateAnimatedSticker(imgBuffer);
                            stickerBuffer = generated.buffer;
                            
                            if (global.stickerCache.size >= 50) {
                                const firstKey = global.stickerCache.keys().next().value;
                                global.stickerCache.delete(firstKey);
                            }
                            global.stickerCache.set(cacheKey, stickerBuffer);
                        }
                        
                        await sock.sendMessage(jid, { sticker: stickerBuffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } }, { quoted: msg });
                        logger.success('[AI] Sticker sent');
                    } catch (err) {
                        logger.error(`[AI] Sticker failed: ${err.message}`);
                    }
                    
                    return;
                } else if (hasImage || hasQuotedImage) {
                    let imgBuffer;
                    if (hasImage) {
                        imgBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                    } else {
                        // Download the quoted image
                        const quotedMsg = { key: { remoteJid: jid, id: ctxInfo.stanzaId, fromMe: false }, message: ctxInfo.quotedMessage };
                        imgBuffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                    }
                    const cleanText = text.replace(/@\d+/g, '').trim().toLowerCase();
                    // If user wants a sticker from the image, convert directly
                    const wantsSticker = /sticker|stickify|convert|make.*sticker|turn.*sticker/i.test(cleanText);
                    if (wantsSticker) {
                        try {
                            const { generateAnimatedSticker } = require('./stickerEngine');
                            const result = await generateAnimatedSticker(imgBuffer);
                            await sock.sendMessage(jid, { sticker: result.buffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } }, { quoted: msg });
                            return;
                        } catch (err) {
                            logger.error('[AI] Image-to-sticker failed: ' + err.message);
                        }
                    }
                    const prompt = cleanText || 'Describe this image';
                    const imageUrl = `data:${hasImage ? (msg.message.imageMessage.mimetype || 'image/jpeg') : (quotedImageMsg.mimetype || 'image/jpeg')};base64,${imgBuffer.toString('base64')}`;
                    response = await unifiedAi.complete({
                        chatJid: jid,
                        prompt,
                        senderName: sender,
                        groupName: isGroup ? jid : '',
                        botName: nodeState.botName || 'Pappy',
                        isGroup,
                        imageUrl,
                    });
                } else if (hasVoice) {
                    const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                    response = await ai.analyzeVoice(audioBuffer, sender);
                    
                    // Reply with voice note instead of text
                    try {
                        const voiceReply = await ai.textToSpeech(response);
                        await sock.sendMessage(jid, { audio: voiceReply, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
                        return;
                    } catch (ttsErr) {
                        logger.warn(`[AI] TTS failed, sending text: ${ttsErr.message}`);
                        // Fall through to send text response
                    }
                } else if (text) {
                    const cleanPrompt = text.replace(/@\d+/g, '').trim();
                    if (!cleanPrompt) return;
                    let groupName = '';
                    if (isGroup) groupName = (await getCachedGroupMeta(sock, jid).catch(() => null))?.subject || '';
                    response = await unifiedAi.complete({
                        chatJid: jid,
                        prompt: cleanPrompt,
                        senderName: msg.pushName || sender,
                        groupName,
                        botName: 'Pappy',
                        isGroup,
                    });
                } else return;

                // Unified AI output is content only. Provider text must never become a
                // command, media action, or operating-system instruction.
                if (/^(EXECUTE_COMMAND|PLAY|GENERATE_IMAGE|SPEAK|SEARCH_VIDEO|SEND_STICKER):/i.test(response)) {
                    response = 'I cannot execute actions embedded in AI-generated text.';
                }

                if (false && response.startsWith('EXECUTE_COMMAND:')) {
                    try {
                        const { exec } = require('child_process');
                        const util = require('util');
                        const execAsync = util.promisify(exec);
                        const command = response.slice(16).trim();
                        
                        // SECURITY: Block destructive commands and protect bot infrastructure
                        const destructivePatterns = [
                            /rm\s+-rf\s+\//, // rm -rf / or any root deletion
                            /rm\s+-rf\s+~/, // rm -rf home directory
                            /rm\s+-rf\s+\*/, // rm -rf * mass deletion
                            /rm.*\/home\/ubuntu/, // any rm targeting /home/ubuntu
                            /rmdir.*\/home\/ubuntu/, // any rmdir targeting /home/ubuntu
                            /mv.*\/home\/ubuntu.*\/dev\/null/, // moving bot files to /dev/null
                            /rm.*omega-v5-final/, // protect main bot
                            /rm.*kord-ai/, // protect kord ai
                            /rm.*pappy/, // protect pappy bots
                            /reboot/, /shutdown/, /poweroff/, /halt/,
                            /mkfs/, /fdisk.*w/, /dd.*of=\/dev/,
                            /pm2\s+(delete|kill)\s+all/, // don't kill all pm2 processes
                            /pm2\s+delete\s+(omega|kord|pappy)/, // don't delete specific bots
                            /systemctl\s+stop\s+(pm2|nginx|mysql|postgres)/ // don't stop critical services
                        ];
                        
                        const isDestructive = destructivePatterns.some(pattern => 
                            pattern.test(command.toLowerCase())
                        );
                        
                        if (isDestructive) {
                            await sendPremiumText(sock, jid, 'nah i\'m not deleting my own infrastructure or the bot files. that\'s self-destruction. i can do everything else tho', { quoted: msg });
                            logger.warn(`[AI] Blocked destructive command: ${command}`);
                            return;
                        }
                        
                        logger.info(`[AI CMD] WA:${sender} → ${command}`);
                        
                        const { stdout, stderr } = await execAsync(command, { 
                            timeout: 30000,
                            maxBuffer: 1024 * 1024
                        });
                        
                        const output = (stdout + stderr).trim();
                        const result = output.length > 0 ? output : 'command executed successfully';
                        logger.success(`[AI CMD] Output:\n${result.slice(0, 500)}`);
                        const finalOutput = result.length > 2000 ? result.slice(0, 2000) + '\n\n... (output truncated)' : result;
                        
                        await sendPremiumText(sock, jid, `\`\`\`\n${finalOutput}\n\`\`\``, { quoted: msg });
                        logger.success('[AI] Command executed');
                    } catch (err) {
                        logger.error(`[AI] Command failed: ${err.message}`);
                        await sendPremiumText(sock, jid, `error: ${err.message}`, { quoted: msg });
                    }
                    return;
                }
                if (false && response.startsWith('PLAY:')) {
                    const musicModule = require('../plugins/pappy-music');
                    await musicModule.execute({ sock, msg, args: response.slice(5).trim().split(' '), text: `.play ${response.slice(5).trim()}`, user: { name: 'AI' }, botId });
                    return;
                }
                if (false && response.startsWith('GENERATE_IMAGE:')) {
                    try { await sock.sendMessage(jid, { image: await ai.generateImage(response.slice(15).trim()), caption: '' }, { quoted: msg }); }
                    catch { await sendPremiumText(sock, jid, "couldn't generate that image", { quoted: msg }); }
                    return;
                }
                if (false && response.startsWith('SPEAK:')) {
                    try { await sock.sendMessage(jid, { audio: await ai.textToSpeech(response.slice(6).trim()), mimetype: 'audio/mpeg', ptt: true }, { quoted: msg }); }
                    catch { await sendPremiumText(sock, jid, response.slice(6).trim(), { quoted: msg }); }
                    return;
                }
                if (false && response.startsWith('SEARCH_VIDEO:')) {
                    try {
                        const { buffer, title, mimetype, url } = await ai.searchVideo(response.slice(13).trim());
                        try {
                            await sock.sendMessage(jid, { video: buffer, caption: title, mimetype: mimetype || 'video/mp4' }, { quoted: msg });
                        } catch (sendErr) {
                            const fallbackText = url
                                ? `Video playback failed on this WhatsApp client.\nTry this link directly:\n${url}`
                                : `Video playback failed on this WhatsApp client. Try another query or use .play for audio.`;
                            await sendPremiumText(sock, jid, fallbackText, { quoted: msg });
                        }
                    } catch {
                        await sendPremiumText(sock, jid, "couldn't find that video", { quoted: msg });
                    }
                    return;
                }
                if (false && response.startsWith('SEND_STICKER:')) {
                    try {
                        const description = response.slice(13).trim();
                        const cacheKey = Buffer.from(description).toString('base64').slice(0, 20);
                        
                        let stickerBuffer;
                        
                        // Check cache first
                        if (global.stickerCache.has(cacheKey)) {
                            logger.info('[AI] Using cached sticker');
                            stickerBuffer = global.stickerCache.get(cacheKey);
                        } else {
                            logger.info(`[AI] Generating sticker: ${description}`);
                            const imgBuffer = await Promise.race([
                                ai.generateImage(description),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 12000))
                            ]);

                            const generated = await generateAnimatedSticker(imgBuffer);
                            stickerBuffer = generated.buffer;
                            
                            // Cache it
                            if (global.stickerCache.size >= 50) {
                                const firstKey = global.stickerCache.keys().next().value;
                                global.stickerCache.delete(firstKey);
                            }
                            global.stickerCache.set(cacheKey, stickerBuffer);
                        }
                        
                        // Send without quoting to avoid old message issues
                        await sock.sendMessage(jid, { sticker: stickerBuffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } });
                        logger.success('[AI] Sticker sent & cached');
                    } catch (err) {
                        logger.error(`[AI] Sticker failed: ${err.message}`);
                        await sendPremiumText(sock, jid, "couldn't make that sticker rn", { quoted: msg });
                    }
                    return;
                }

                await sendPremiumText(sock, jid, response, { quoted: msg });
                // Post-text sticker removed: was generating + sending an animated sticker
                // after every AI text reply, doubling socket load and blocking the event loop.

            } catch (err) {
                logger.warn(`[AI] Failed: ${err.message}`);
                await sendPremiumText(sock, jid, 'something went wrong, try again', { quoted: msg }).catch(() => {});
            }
            }); // End AI queue task
            return;
        }

        engine.triggerMessage({ sock, msg, text, isGroup, sender, botId, isGroupAdmin });
        } catch (err) {
            logger.error(`[WA] messages.upsert crash prevented: ${err.message}`);
        }
    });

    // ─── KEEP GROUP CACHE FRESH ON PARTICIPANT / METADATA CHANGES ────────────────
    // ── POLL VOTE HANDLER — for .song poll selection ────────────────────────────────
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            try {
                if (!update.update?.pollUpdates) continue;
                const pollVote = update.update.pollUpdates[0];
                if (!pollVote) continue;
                const groupJid = update.key?.remoteJid;

                const pollCreationKey = pollVote.pollCreationMessageKey?.id || update.key?.id;
                const cachedPoll = global.messageCache?.get(pollCreationKey);
                if (!cachedPoll) continue;
                const pollName = cachedPoll?.message?.pollCreationMessageV3?.name || cachedPoll?.message?.pollCreationMessage?.name || '';
                if (!pollName.includes('Pick a track') && !pollName.includes('Pick a song')) continue;

                const voterJid = pollVote?.pollUpdateMessageKey?.participant || update.key?.participant || update.key?.remoteJid;
                const selectedNames = (await resolveSongPollSelections(pollVote, cachedPoll, {
                    sock,
                    pollMsgId: pollCreationKey,
                    pollUpdateMessageKey: pollVote?.pollUpdateMessageKey,
                    voterJid,
                    pollCreatorJid: sock.user?.id,
                    messageSecret: global._songPollLookup?.get(pollCreationKey)?.messageSecret,
                }))
                    .map((name) => String(name || '').replace(/\s*\[.*?\]\s*$/, '').trim())
                    .filter(Boolean);
                if (!selectedNames.length) continue;

                await handleSongPollSelection(sock, groupJid, pollCreationKey || update.key?.id || '', selectedNames);
            } catch {}
        }
    });

    // ── POLL VOTE HANDLER — poll votes come as pollUpdateMessage in messages.upsert ──
    // NOTE: This is handled inside the primary messages.upsert handler above.
    // A second sock.ev.on('messages.upsert') registration was removed here to
    // prevent duplicate listener stacking which doubled event processing load.


    sock.ev.on('groups.update', (updates) => {
        if (!global._groupInvalidateQueues) global._groupInvalidateQueues = new Map();
        const key = sessionKey;
        let state = global._groupInvalidateQueues.get(key);
        if (!state) {
            state = { ids: new Set(), timer: null };
            global._groupInvalidateQueues.set(key, state);
        }
        for (const update of updates) {
            if (update.id) state.ids.add(update.id);
        }
        if (state.timer) return;
        state.timer = setTimeout(() => {
            try {
                for (const jid of state.ids) groupCache.invalidate(jid, sock);
            } finally {
                state.ids.clear();
                state.timer = null;
            }
        }, 1000);
        state.timer.unref?.();
    });
    // Re-emit presence updates onto the internal event bus so anti/presence-
    // based features can subscribe. Purely additive; safe with no listeners.
    sock.ev.on('presence.update', ({ id, presences }) => {
        if (!id) return;
        try {
            const botIdNow = sock.user?.id?.split(':')[0] || phoneNumber;
            require('./eventBus').emit('presence.update', { botId: botIdNow, jid: id, presences });
        } catch {}
    });

    sock.ev.on('group-participants.update', ({ id }) => {
        if (!id) return;
        if (!global._groupInvalidateQueues) global._groupInvalidateQueues = new Map();
        const key = sessionKey;
        let state = global._groupInvalidateQueues.get(key);
        if (!state) {
            state = { ids: new Set(), timer: null };
            global._groupInvalidateQueues.set(key, state);
        }
        state.ids.add(id);
        if (state.timer) return;
        state.timer = setTimeout(() => {
            try {
                for (const jid of state.ids) groupCache.invalidate(jid, sock);
            } finally {
                state.ids.clear();
                state.timer = null;
            }
        }, 1000);
        state.timer.unref?.();
    });

    return sock;
}

function setPappyMode(jid, value, phone) {
if (phone) {
const state = getNodeState(phone);
if (!state.pappyMode) state.pappyMode = {};
state.pappyMode[jid] = value;
saveNodeState(phone);
const tgUserId = pairingRegistry.getUserIdByPhone(String(phone).replace(/[^0-9]/g, ''));
if (tgUserId && String(jid).endsWith('@g.us')) {
createAiEngine(tgUserId).setGroupMode(jid, value === true).catch((error) => logger.warn(`[AI] Could not persist group mode: ${error.message}`));
}
} else {
if (!botState.pappyMode) botState.pappyMode = {};
botState.pappyMode[jid] = value;
saveState();
}
}

module.exports = { startWhatsApp, activeSockets, loadState, saveState, botState, setPappyMode, getCommandPrefix, setCommandPrefix, getNodeMode, setNodeMode, getNodeState };
