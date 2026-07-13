// plugins/pappy-broadcast.js
// 👑 THE ULTIMATE GCAST/GODCAST HYBRID ENGINE

const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@crysnovax/baileys');
const { broadcastQueue, registerCampaign } = require('../core/bullEngine'); 
const logger = require('../core/logger');
const ghostMode = require('../core/ghostMode');
const crypto = require('crypto');
const linkPreviewCache = require('../core/linkPreviewCache');

const SCHEDULE_FILE = path.join(__dirname, '../data/schedule-db.json');
const TEMP_DIR = path.join(__dirname, '../data/temp_media');
const activeSchedules = new Map();
const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
const groupCache = new Map();
const GODCAST_JOB_ATTEMPTS = Math.max(1, Number(process.env.GODCAST_JOB_ATTEMPTS || 8));
const GCAST_JOB_ATTEMPTS = Math.max(1, Number(process.env.GCAST_JOB_ATTEMPTS || 5));
const BROADCAST_JOB_BACKOFF_MS = Math.max(1500, Number(process.env.BROADCAST_JOB_BACKOFF_MS || 12000));
const GODCAST_QUEUE_DELAY_JITTER_MS = Math.max(0, Number(process.env.GODCAST_QUEUE_DELAY_JITTER_MS || 3000));
const GODCAST_CHUNK_PAUSE_MS = Math.max(100, Number(process.env.GODCAST_CHUNK_PAUSE_MS || 600));
const LARGE_GROUP_THRESHOLD = Math.max(50, Number(process.env.GODCAST_LARGE_GROUP_THRESHOLD || 200));
const GODCAST_LARGE_GROUP_JOB_ATTEMPTS = Math.max(GODCAST_JOB_ATTEMPTS, Number(process.env.GODCAST_LARGE_GROUP_JOB_ATTEMPTS || 12));

function extractRelaySourceMessage(quotedMsg) {
    if (!quotedMsg || typeof quotedMsg !== 'object') return null;
    if (quotedMsg.ephemeralMessage?.message) return extractRelaySourceMessage(quotedMsg.ephemeralMessage.message);
    if (quotedMsg.viewOnceMessage?.message)  return extractRelaySourceMessage(quotedMsg.viewOnceMessage.message);
    // extendedTextMessage first — carries full link preview (title, jpegThumbnail, matchedText)
    if (quotedMsg.extendedTextMessage) return { extendedTextMessage: quotedMsg.extendedTextMessage };
    if (quotedMsg.groupInviteMessage)  return { groupInviteMessage: quotedMsg.groupInviteMessage };
    if (quotedMsg.conversation)        return { conversation: quotedMsg.conversation };
    return null;
}

function extractRelaySourceContextInfo(msg) {
    const primaryCtx = msg?.message?.extendedTextMessage?.contextInfo || null;
    const quotedMsg = primaryCtx?.quotedMessage || {};

    return (
        quotedMsg?.extendedTextMessage?.contextInfo ||
        quotedMsg?.imageMessage?.contextInfo ||
        quotedMsg?.videoMessage?.contextInfo ||
        null
    );
}

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Prevents the event loop from blocking during massive array processing
const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

// Godcast aesthetics live in core/godcastTemplates.js (single curated source, applied per-group in the worker).

async function saveSchedules() { 
    try {
        const data = [...activeSchedules.values()].map(s => s.meta);
        await fs.promises.writeFile(SCHEDULE_FILE, JSON.stringify(data, null, 2)); 
    } catch (error) { logger.error(`[Broadcast] Failed to save schedules: ${error.message}`); }
}

function parseTime(input) {
    const value = parseInt(input);
    if (isNaN(value)) return null;
    if (input.endsWith('m')) return Date.now() + value * 60000;
    if (input.endsWith('h')) return Date.now() + value * 3600000;
    return null;
}

function queueSchedule(meta) {
    const delayMs = meta.time - Date.now();
    const waitTime = Math.max(delayMs, 2000);
    
    const timeout = setTimeout(async () => {
        try {
            const sock = global.waSocks?.get(meta.botId);
            if (sock) {
                const jids = await fetchAllGroups(sock, meta.botId);
                await executeBroadcastTask(sock, jids, meta.text, meta.mode, meta.chat, meta.isGodcast, null, false, meta.sourceMessage || null, meta.sourceContextInfo || null);
            }
        } catch (error) { logger.error(`[Broadcast] Schedule execution failed: ${error.message}`); } 
        finally {
            if (meta.isLoop) {
                meta.time += meta.loopInterval; 
                queueSchedule(meta); 
                saveSchedules();
            } else {
                activeSchedules.delete(meta.id); 
                saveSchedules();
            }
        }
    }, waitTime);
    
    activeSchedules.set(meta.id, { timeout, meta });
}

async function fetchAllGroups(sock, botId, minMembers = 5) {
    const cacheKey = String(botId || sock.user?.id || 'default');
    const cached = groupCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < GROUP_CACHE_TTL_MS) {
        return cached.groups;
    }

    const raw = await require('../core/groupCache').getAllGroups(sock, true);
    const groups = Object.values(raw)
        .filter(g => {
            // Only include groups where bot can send (not announce-only unless bot is admin)
            if (!g.id || !g.id.endsWith('@g.us')) return false;
            if (g.participants.length < 2) return false; // skip empty groups
            const botId = sock.user?.id?.split(':')[0];
            const botParticipant = g.participants.find(p => p.id?.includes(botId));
            // If group is announce-only, bot must be admin to send
            if (g.announce && botParticipant?.admin !== 'admin' && botParticipant?.admin !== 'superadmin') return false;
            return true;
        })
        .filter(g => g.participants.length >= minMembers)
        .map(g => ({
            id: g.id,
            size: g.participants.length,
            participants: g.participants
                .map(p => p.id)
                .filter(j => typeof j === 'string' && /@(s\.whatsapp\.net|lid)$/.test(j))
        }));
    groupCache.set(cacheKey, { groups, ts: Date.now() });
    return groups;
}

// ==========================================
// 🚀 SUPREME BROADCAST ENGINE
// ==========================================
async function executeBroadcastTask(sock, groupData, textContent, mode, chat, isGodcast, mediaPath, isVideo, sourceMessage = null, sourceContextInfo = null, gsConfig = null, castType = null) {
    // Remove any global blocking state for godcast; allow concurrent godcast commands
    const botId = sock.user.id.split(':')[0];
    const jids = groupData.map(g => g.id);
    // magiccast behaves like godcast (ghost + status) but is its own command type so the worker
    // can apply rotating colours; gcast/godcast keep their existing behaviour.
    const resolvedCastType = castType || (isGodcast ? 'godcast' : 'gcast');
    const campaignId = `CAMP_${botId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    registerCampaign({
        campaignId,
        botId,
        chat,
        mode: resolvedCastType,
        total: jids.length,
    });
    let finalPayloadText = textContent;
    const shouldUseGhost = !!isGodcast;
    const resolvedBg   = gsConfig?.backgroundColor || '#00C853';
    const resolvedFont = gsConfig?.font !== undefined ? gsConfig.font : 3;

    // Godcast: derive the text from the relayed source when the command had no inline text.
    // The curated aesthetic wrap (core/godcastTemplates.js) is applied PER GROUP inside the
    // worker, so each group gets a stable, distinct design and the link stays on its own
    // line for the status preview card. We pass the RAW text here and flag the wrap.
    if (isGodcast) {
        if (!finalPayloadText && sourceMessage?.extendedTextMessage?.text) {
            finalPayloadText = sourceMessage.extendedTextMessage.text;
        }
        if (!finalPayloadText && sourceMessage?.conversation) {
            finalPayloadText = sourceMessage.conversation;
        }
    }

    let totalJobs = 0;
    let chunk = [];
    for (const group of groupData) {
        const isLargeGroup = Number(group?.size || 0) >= LARGE_GROUP_THRESHOLD;
        chunk.push({
            name: `BCAST_${botId}_${group.id}`,
            data: {
                botId,
                targetJid: group.id,
                groupSize: Number(group?.size || 0),
                mentions: !isGodcast ? (group.participants || []) : [],
                textContent: finalPayloadText,
                mode,
                commandType: resolvedCastType,
                aestheticWrap: isGodcast,
                font: resolvedFont,
                backgroundColor: resolvedBg,
                useGhostProtocol: shouldUseGhost,
                mediaPath,
                isVideo,
                // Only pass real relay source payloads (quoted/current WA messages).
                // Synthetic prefetch metadata must not masquerade as sourceMessage,
                // otherwise downstream status/chat builders may skip native preview flow.
                sourceMessage: sourceMessage || null,
                sourceContextInfo,
                campaignId
            },
            opts: {
                priority: group.size > 100 ? 1 : 3,
                removeOnComplete: true,
                removeOnFail: 1000,
                // For godcast we keep retries inside the worker itself so one group fully
                // completes (success/final-fail) before the next group job is processed.
                attempts: isGodcast ? 1 : GCAST_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: BROADCAST_JOB_BACKOFF_MS },
                delay: isGodcast ? Math.floor(Math.random() * (GODCAST_QUEUE_DELAY_JITTER_MS + 1)) : 0,
            }
        });
        totalJobs++;

        if (chunk.length >= 50) {  // reduced from 500 — smaller batches prevent Redis overload
            try {
                await broadcastQueue.addBulk(chunk);
                chunk = [];
                await yieldLoop();
                if (isGodcast) await new Promise(r => setTimeout(r, GODCAST_CHUNK_PAUSE_MS)); // extra breathing room for godcast
            } catch (error) { logger.error(`[Broadcast] Redis Bulk Add Failed: ${error.message}`); }
        }
    }

    if (chunk.length) {
        try {
            await broadcastQueue.addBulk(chunk);
        } catch (error) { logger.error(`[Broadcast] Redis Bulk Add Failed: ${error.message}`); }
    }
    const ghostNote = isGodcast ? `\n👻 Ghost Protocol: ON (forced reliability mode)` : '';
    await sock.sendMessage(chat, { text: `  ⬢ *ENGINE ENGAGED* —— ${totalJobs} drops injected into Redis queue.${ghostNote}` });
    // Nudge presence so WA server knows the socket is still alive after heavy queue injection
    setTimeout(() => { sock.sendPresenceUpdate('available').catch(() => {}); }, 3000);
}

module.exports = {
    category: 'BROADCAST',
    commands: [
        { cmd: '.gcast', role: 'owner' }, { cmd: '.godcast', role: 'owner' }, { cmd: '.magiccast', role: 'owner' }, { cmd: '.stopcast', role: 'owner' },
        { cmd: '.schedulecast', role: 'owner' }, { cmd: '.schedulegodcast', role: 'owner' },
        { cmd: '.loopcast', role: 'owner' }, { cmd: '.loopgodcast', role: 'owner' },
        { cmd: '.listschedule', role: 'owner' }, { cmd: '.cancelschedule', role: 'owner' }
    ],
    init: () => {
        if (!fs.existsSync(path.join(__dirname, '../data'))) fs.mkdirSync(path.join(__dirname, '../data'));
        if (fs.existsSync(SCHEDULE_FILE)) {
            try { JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8')).forEach(queueSchedule); } catch(e) {}
        }
    },
    
    execute: async ({ sock, msg, args, text, user, botId }) => {
        const chat = msg.key.remoteJid;
        const rawText = String(text || '').replace(/^\.\ +/, '.').trim();
        let cmd = rawText.split(/\s+/)[0].toLowerCase();
        let normArgs = rawText.slice(cmd.length).trim().split(/\s+/).filter(Boolean);

        // Support spaced mobile variants like ".god cast" and ".g cast"
        if (cmd === '.god' && normArgs[0]?.toLowerCase() === 'cast') {
            cmd = '.godcast';
            normArgs = normArgs.slice(1);
        }
        if (cmd === '.g' && normArgs[0]?.toLowerCase() === 'cast') {
            cmd = '.gcast';
            normArgs = normArgs.slice(1);
        }
        // Support spaced ".magic cast"
        if (cmd === '.magic' && normArgs[0]?.toLowerCase() === 'cast') {
            cmd = '.magiccast';
            normArgs = normArgs.slice(1);
        }
        
        // Extract preview from CURRENT message (when user types command with link and preview loads)
        const currentMessageExtended = msg.message?.extendedTextMessage;
        const currentMessageContextInfo = currentMessageExtended?.contextInfo;
        
        // Extract preview from QUOTED message (when user replies to a message)
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
        
        // Determine which preview to use:
        // 1. If current message has link preview (externalAdReply or matchedText), use it
        // 2. Otherwise, use quoted message preview
        // 3. Fallback: check cache for the link
        let relaySourceMessage = null;
        let relaySourceContextInfo = null;
        
        // Check if current message has a link preview
        const hasCurrentPreview = currentMessageContextInfo?.externalAdReply || currentMessageExtended?.matchedText;
        
        if (hasCurrentPreview) {
            // User typed command with link and preview loaded - use current message
            logger.info('[Broadcast] Using preview from current message');
            relaySourceMessage = { extendedTextMessage: currentMessageExtended };
            relaySourceContextInfo = currentMessageContextInfo;
            
            // Cache this preview for future use
            const currentText = currentMessageExtended?.text || '';
            if (currentText) {
                const cacheResult = linkPreviewCache.cacheFromMessage(msg, currentText);
                if (cacheResult?.cached) {
                    logger.info(`[Broadcast] Cached preview for: ${cacheResult.url?.slice(0, 60)}`);
                }
            }
        } else if (quotedMsg) {
            // User replied to a message - use quoted message preview
            logger.info('[Broadcast] Using preview from quoted message');
            relaySourceMessage = extractRelaySourceMessage(quotedMsg);
            relaySourceContextInfo = extractRelaySourceContextInfo(msg);
            
            // Cache quoted preview
            if (quotedText && quotedMsg?.extendedTextMessage) {
                const quotedMsgObj = { message: { extendedTextMessage: quotedMsg.extendedTextMessage } };
                const cacheResult = linkPreviewCache.cacheFromMessage(quotedMsgObj, quotedText);
                if (cacheResult?.cached) {
                    logger.info(`[Broadcast] Cached quoted preview for: ${cacheResult.url?.slice(0, 60)}`);
                }
            }
        }

        if (cmd === '.stopcast') { return sock.sendMessage(chat, { text: '  ⌬ _payloads aborted._' }); }

        const schedCmds = ['.schedulecast', '.schedulegodcast', '.loopcast', '.loopgodcast'];
        if (schedCmds.includes(cmd)) {
            const timeArg = normArgs.shift();
            const textContent = normArgs.join(' ') || quotedText;
            if (!timeArg || !textContent) return sock.sendMessage(chat, { text: '  ◎ *Usage:* `.schedulecast 10m Message`' });
            
            const time = parseTime(timeArg);
            if (!time) return sock.sendMessage(chat, { text: '  ◎ _invalid time format — use m or h (e.g., 15m)._' });
            
            const id = 'SCH-' + Math.random().toString(36).slice(2, 8).toUpperCase();
            const isGodcast = cmd.includes('godcast');
            const mode = isGodcast ? 'advanced_status' : 'normal';
            const isLoop = cmd.startsWith('.loop');
            
            queueSchedule({
                id,
                chat,
                botId,
                text: textContent,
                time,
                mode,
                isLoop,
                loopInterval: isLoop ? (time - Date.now()) : null,
                isGodcast,
                // Keep quoted source preview whenever present for scheduled status-mode sends.
                sourceMessage: relaySourceMessage || null,
                sourceContextInfo: relaySourceContextInfo || null
            });
            saveSchedules();
            return sock.sendMessage(chat, { text: `  ⟡ *Scheduled* —— ${id}` });
        }

        if (cmd === '.listschedule' || cmd === '.cancelschedule') {
            if (cmd === '.cancelschedule') {
                if (activeSchedules.has(normArgs[0])) { 
                    clearTimeout(activeSchedules.get(normArgs[0]).timeout);
                    activeSchedules.delete(normArgs[0]); 
                    saveSchedules(); 
                    return sock.sendMessage(chat, {text: '  ⌬ _cancelled._'}); 
                }
                return sock.sendMessage(chat, {text: '  ⌬ _schedule ID not found._'});
            }
            return sock.sendMessage(chat, { text: `  ⟡ *Active drops* —— ${activeSchedules.size}` });
        }

        if (cmd === '.gcast' || cmd === '.godcast' || cmd === '.magiccast') {
            let textContent = normArgs.join(' ').trim();

            // If replying to a message, extract text from quoted message
            if (!textContent && quotedMsg) {
                textContent = quotedMsg?.extendedTextMessage?.text
                    || quotedMsg?.conversation
                    || quotedMsg?.extendedTextMessage?.matchedText
                    || quotedText
                    || '';
            }
            
            // 🖼️ MEDIA HANDLING SUPPORT
            let mediaPath = null;
            let isVideo = false;
            const hasMedia = quotedMsg?.imageMessage || quotedMsg?.videoMessage;

            if (hasMedia) {
                try {
                    const ext = quotedMsg.videoMessage ? '.mp4' : '.jpg';
                    isVideo = !!quotedMsg.videoMessage;
                    mediaPath = path.join(TEMP_DIR, `BCAST_${crypto.randomBytes(4).toString('hex')}${ext}`);
                    const buffer = await downloadMediaMessage({ key: msg.key, message: quotedMsg }, 'buffer', { }, { logger: null, reuploadRequest: sock.updateMediaMessage });
                    await fs.promises.writeFile(mediaPath, buffer);
                } catch (mediaErr) { mediaPath = null; }
            }

            if (!textContent && !mediaPath) return sock.sendMessage(chat, { text: '  ◎ _payload required._' });
            
            // NEW: If no preview detected but text contains URL, check cache
            if (!relaySourceMessage && !relaySourceContextInfo && textContent) {
                const cachedEntry = linkPreviewCache.getCachedFromText(textContent);
                if (cachedEntry) {
                    logger.info('[Broadcast] Using cached preview as fallback');
                    const contextInfo = linkPreviewCache.buildContextInfo(cachedEntry);
                    if (contextInfo) {
                        // Build relay message from cached data
                        relaySourceMessage = { 
                            extendedTextMessage: { 
                                text: textContent,
                                matchedText: cachedEntry.preview.matchedText || cachedEntry.preview.sourceUrl || cachedEntry.url,
                                canonicalUrl: cachedEntry.preview.canonicalUrl || cachedEntry.url,
                            }
                        };
                        relaySourceContextInfo = contextInfo;
                    }
                }
            }
            
            const isMagic = cmd === '.magiccast';
            const isGodcast = cmd === '.godcast' || isMagic; // magiccast = ghost + status mode
            const castType = isMagic ? 'magiccast' : (cmd === '.godcast' ? 'godcast' : 'gcast');
            const groupData = await fetchAllGroups(sock, botId);
            if (!Array.isArray(groupData) || groupData.length === 0) {
                return sock.sendMessage(chat, {
                    text: '⚠️ No eligible groups found for broadcast right now.'
                });
            }
            const gsPlugin = (() => { try { return require('./pappy-groupstatus'); } catch { return null; } })();
            const gsConfig = gsPlugin?.getGsConfig(botId) || null;
            if (isMagic) {
                await sock.sendMessage(chat, { text: '  🪄 *MAGIC CAST* — painting every group a different colour…' });
            }
            await executeBroadcastTask(
                sock,
                groupData,
                textContent,
                isGodcast ? 'advanced_status' : 'normal',
                chat,
                isGodcast,
                mediaPath,
                isVideo,
                !mediaPath ? (relaySourceMessage || null) : null,
                !mediaPath ? (relaySourceContextInfo || null) : null,
                gsConfig,
                castType
            );
        }
    }
};
