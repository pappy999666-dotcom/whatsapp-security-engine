// core/baileysComplete.js
// 🔥 COMPLETE BAILEYS FEATURE EXTRACTION + FIXES
// Extracts ALL features from @rexxhayanasi/elaina-baileys and adds missing ones

const crypto = require('crypto');
const logger = require('./logger');

/**
 * Generate a display-only formatted pairing code string.
 * NOTE: WhatsApp's actual pairing code is generated server-side via
 * sock.requestPairingCode(phone). This helper is only used for
 * display/logging purposes and is NOT passed to the API.
 */
function generatePairingCode() {
    const code = Math.floor(10000000 + Math.random() * 90000000).toString();
    return code.slice(0, 4) + '-' + code.slice(4);
}

/**
 * Complete Feature Set from @rexxhayanasi/elaina-baileys
 * These are ALL the methods available in the socket
 */
const REALVARE_FEATURES = {
    // Core
    type: 'Socket type identifier',
    ws: 'WebSocket connection',
    ev: 'Event emitter',
    authState: 'Authentication state (creds, keys)',
    signalRepository: 'Signal protocol repository',
    user: 'Current user info',
    
    // Message handling
    generateMessageTag: 'Generate unique message tags',
    query: 'Send IQ queries',
    waitForMessage: 'Wait for specific message',
    waitForSocketOpen: 'Wait for socket to open',
    sendRawMessage: 'Send raw binary message',
    sendNode: 'Send binary node',
    sendWAMBuffer: 'Send WAM telemetry',
    
    // Connection
    logout: 'Logout and end session',
    end: 'End connection',
    onUnexpectedError: 'Handle unexpected errors',
    uploadPreKeys: 'Upload pre-keys',
    uploadPreKeysToServerIfRequired: 'Auto upload pre-keys',
    waitForConnectionUpdate: 'Wait for connection state change',
    
    // Pairing (FIXED)
    requestPairingCode: 'Request pairing code (FIXED VERSION)',
    
    // Polls
    sendPoll: 'Send WhatsApp poll',
    
    // LID (Linked ID) Support
    assertLid: 'Assert JID is a LID',
    getLIDById: 'Get LID from JID',
    getPNById: 'Get phone number from LID',
    storeLidPnMapping: 'Store LID-PN mapping',
    
    // Newsletter Support
    newsletterCreate: 'Create newsletter',
    getNewsletterInfo: 'Get newsletter metadata',
    getNewsletterMessage: 'Get newsletter message',
    updateNewsletterMute: 'Mute/unmute newsletter',
    toggleNewsletterSubscribe: 'Subscribe/unsubscribe newsletter',
    
    // Interactive Messages
    sendInteractiveMessage: 'Send buttons/lists',
    
    // Business Features
    getCatalog: 'Get business catalog',
    getCollections: 'Get product collections',
    productCreate: 'Create product',
    productDelete: 'Delete product',
    productUpdate: 'Update product',
    
    // Communities (if available)
    communityCreate: 'Create community',
    getCommunityInfo: 'Get community metadata',
    
    // Advanced
    relayMessage: 'Relay message to server',
    generateWAMessageContent: 'Generate WA message content',
    generateWAMessageFromContent: 'Generate WA message from content'
};

/**
 * Apply ALL enhancements to socket
 */
function enhanceBaileysComplete(sock) {
    if (!sock) {
        logger.error('[BaileysComplete] Cannot enhance null socket');
        return sock;
    }

    // Don't enhance twice
    if (sock._enhancedComplete) return sock;

    logger.info('[BaileysComplete] Applying complete enhancement...');

    // ✅ FIX 1: Pairing Code — do NOT wrap requestPairingCode.
    // Baileys generates the code server-side; passing a custom code breaks the flow.
    // The correct call is: sock.requestPairingCode(phoneNumber) — no second arg.

    // ✅ FIX 2: Group Status Sending (from gifted-baileys)
    sock.sendGroupStatus = async function(groupJid, content, options = {}) {
        try {
            const { generateWAMessageContent, generateMessageID } = require('@crysnovax/baileys');
            
            let waMsgContent;
            if (content.message) {
                waMsgContent = content;
            } else if (content.groupStatusMessage) {
                waMsgContent = { message: content };
            } else {
                waMsgContent = await generateWAMessageContent(content, {
                    upload: sock.waUploadToServer,
                });
            }

            const msg = {
                message: {
                    groupStatusMessageV2: {
                        message: waMsgContent.message || waMsgContent
                    }
                }
            };

            const messageId = options.messageId || generateMessageID();
            return await sock.relayMessage(groupJid, msg.message, { messageId, ...options });
        } catch (error) {
            logger.error(`[GroupStatus] Failed: ${error.message}`);
            throw error;
        }
    };

    // ✅ FIX 3: Batch Group Operations
    sock.batchGroupParticipantsUpdate = async function(groupJid, participants, action, batchSize = 20) {
        const results = [];
        for (let i = 0; i < participants.length; i += batchSize) {
            const batch = participants.slice(i, i + batchSize);
            try {
                const result = await sock.groupParticipantsUpdate(groupJid, batch, action);
                results.push(...result);
            } catch (error) {
                results.push({ status: 'error', jid: batch, error: error.message });
            }
            if (i + batchSize < participants.length) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        return results;
    };

    // ✅ FIX 4: Enhanced Message Sending with Retry
    sock.sendMessageEnhanced = async function(jid, content, options = {}) {
        const maxRetries = options.maxRetries || 3;
        const retryDelay = options.retryDelay || 2000;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await sock.sendMessage(jid, content, options);
            } catch (error) {
                lastError = error;
                const errMsg = String(error.message || '').toLowerCase();
                
                if (errMsg.includes('forbidden') || errMsg.includes('not-authorized') || errMsg.includes('logged out')) {
                    throw error;
                }

                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, retryDelay * attempt));
                }
            }
        }
        throw lastError;
    };

    // ✅ FIX 5: Smart Group Metadata Cache
    if (!sock._groupMetaCache) sock._groupMetaCache = new Map();
    
    sock.getGroupMetadataCached = async function(groupJid, force = false) {
        const cached = sock._groupMetaCache.get(groupJid);
        const now = Date.now();
        
        if (!force && cached && (now - cached.timestamp < 5 * 60 * 1000)) {
            return cached.data;
        }

        try {
            const meta = await sock.groupMetadata(groupJid);
            sock._groupMetaCache.set(groupJid, { data: meta, timestamp: now });
            return meta;
        } catch (error) {
            if (cached) return cached.data;
            throw error;
        }
    };

    // ✅ FIX 6: Full Profile Picture
    sock.getFullProfilePicture = async function(jid) {
        try {
            const ppUrl = await sock.profilePictureUrl(jid, 'image');
            const axios = require('axios');
            const response = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 15000 });
            return Buffer.from(response.data);
        } catch (error) {
            return null;
        }
    };

    // ✅ FIX 7: Newsletter Features (if not already available)
    if (!sock.newsletterCreate) {
        logger.warn('[BaileysComplete] Newsletter features not available in this version');
    }

    // ✅ FIX 8: Interactive Messages Helper
    sock.sendButtons = async function(jid, text, buttons, options = {}) {
        const interactiveMessage = {
            body: { text },
            footer: options.footer ? { text: options.footer } : undefined,
            nativeFlowMessage: {
                buttons: buttons.map((btn, idx) => ({
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.text,
                        id: btn.id || `btn_${idx}`
                    })
                }))
            }
        };

        return await sock.sendMessage(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {}
                    },
                    interactiveMessage
                }
            }
        }, options);
    };

    // ✅ FIX 9: List Messages Helper
    sock.sendList = async function(jid, text, buttonText, sections, options = {}) {
        const interactiveMessage = {
            body: { text },
            footer: options.footer ? { text: options.footer } : undefined,
            header: options.header ? { title: options.header } : undefined,
            nativeFlowMessage: {
                buttons: [{
                    name: 'single_select',
                    buttonParamsJson: JSON.stringify({
                        title: buttonText,
                        sections: sections
                    })
                }]
            }
        };

        return await sock.sendMessage(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {}
                    },
                    interactiveMessage
                }
            }
        }, options);
    };

    // ✅ FIX 10: Fast Admin Check
    sock.isGroupAdmin = async function(groupJid, userJid) {
        try {
            const meta = await sock.getGroupMetadataCached(groupJid);
            const normalizedUser = userJid.replace(/:\d+@/g, '@');
            const participant = meta.participants.find(p => {
                const pid = String(p.id || '').replace(/:\d+@/g, '@');
                return pid === normalizedUser;
            });
            return participant?.admin ? true : false;
        } catch (error) {
            return false;
        }
    };

    sock._enhancedComplete = true;
    logger.success('[BaileysComplete] ✅ ALL features enhanced and fixed!');
    
    return sock;
}

/**
 * Get list of all available features
 */
function listAllFeatures(sock) {
    const features = [];
    
    for (const key in sock) {
        if (typeof sock[key] === 'function') {
            features.push({
                name: key,
                type: 'function',
                description: REALVARE_FEATURES[key] || 'Custom function'
            });
        }
    }
    
    return features;
}

module.exports = { enhanceBaileysComplete, listAllFeatures, generatePairingCode, REALVARE_FEATURES };
