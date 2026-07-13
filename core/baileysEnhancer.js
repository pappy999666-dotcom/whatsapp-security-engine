// core/baileysEnhancer.js
// 🔥 ULTIMATE BAILEYS ENHANCER — Adds ALL gifted-baileys features to @rexxhayanasi/elaina-baileys
// Combines the best of both worlds: latest protocol + custom features

const { 
    generateWAMessageContent, 
    generateWAMessageFromContent, 
    generateMessageID,
    jidNormalizedUser,
    isJidGroup
} = require('@crysnovax/baileys');
const crypto = require('crypto');
const logger = require('./logger');

/**
 * Enhanced Group Status Handler
 * Adds gifted-baileys gcstatus functionality to any socket
 */
class EnhancedGroupStatus {
    constructor(sock) {
        this.sock = sock;
    }

    /**
     * Send Group Status (replaces gifted-baileys sendGroupStatus)
     * @param {string} groupJid - Target group JID
     * @param {object} content - Message content
     * @param {object} options - Additional options
     */
    async sendGroupStatus(groupJid, content, options = {}) {
        try {
            let waMsgContent;

            // Handle different content formats
            if (content.message) {
                waMsgContent = content;
            } else if (content.groupStatusMessage) {
                // Already formatted
                waMsgContent = { message: content };
            } else {
                // Generate WA message content
                waMsgContent = await generateWAMessageContent(content, {
                    upload: this.sock.waUploadToServer,
                });
            }

            // Wrap in groupStatusMessageV2 (latest WhatsApp format)
            const msg = {
                message: {
                    groupStatusMessageV2: {
                        message: waMsgContent.message || waMsgContent
                    }
                }
            };

            const messageId = options.messageId || generateMessageID();

            logger.info(`[EnhancedGStatus] Sending to ${groupJid}`);

            return await this.sock.relayMessage(groupJid, msg.message, {
                messageId,
                ...options
            });
        } catch (error) {
            logger.error(`[EnhancedGStatus] Failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send status to multiple groups at once
     * @param {object} content - Message content
     * @param {array} jids - Array of group JIDs
     */
    async sendStatusToGroups(content, jids = []) {
        const results = [];
        
        for (const jid of jids) {
            try {
                const result = await this.sendGroupStatus(jid, content);
                results.push({ jid, success: true, result });
            } catch (error) {
                results.push({ jid, success: false, error: error.message });
                logger.warn(`[EnhancedGStatus] Failed for ${jid}: ${error.message}`);
            }
        }

        return results;
    }

    /**
     * Advanced group status with custom styling
     * @param {string} groupJid - Target group
     * @param {string} text - Text content
     * @param {object} style - Style options (font, backgroundColor)
     */
    async sendStyledGroupStatus(groupJid, text, style = {}) {
        const content = {
            groupStatusMessage: {
                text: text,
                font: style.font !== undefined ? style.font : 3,
                backgroundColor: style.backgroundColor || '#00C853'
            }
        };

        return await this.sendGroupStatus(groupJid, content, style.options || {});
    }
}

/**
 * Enhanced Message Sending
 * Adds advanced features for message composition
 */
class EnhancedMessaging {
    constructor(sock) {
        this.sock = sock;
    }

    /**
     * Send message with automatic retry and error handling
     * @param {string} jid - Target JID
     * @param {object} content - Message content
     * @param {object} options - Send options
     */
    async sendMessageEnhanced(jid, content, options = {}) {
        const maxRetries = options.maxRetries || 3;
        const retryDelay = options.retryDelay || 2000;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.sock.sendMessage(jid, content, options);
            } catch (error) {
                lastError = error;
                const errMsg = String(error.message || '').toLowerCase();

                // Don't retry on permanent errors
                if (errMsg.includes('forbidden') || errMsg.includes('not-authorized') || errMsg.includes('logged out')) {
                    throw error;
                }

                if (attempt < maxRetries) {
                    logger.warn(`[EnhancedMsg] Retry ${attempt}/${maxRetries} for ${jid}: ${error.message}`);
                    await new Promise(r => setTimeout(r, retryDelay * attempt));
                } else {
                    throw error;
                }
            }
        }

        throw lastError;
    }

    /**
     * Send media with progress tracking
     * @param {string} jid - Target JID
     * @param {Buffer} media - Media buffer
     * @param {string} type - Media type (image, video, audio, document)
     * @param {object} options - Additional options
     */
    async sendMediaWithProgress(jid, media, type, options = {}) {
        const caption = options.caption || '';
        const mimetype = options.mimetype;
        const fileName = options.fileName;

        const content = {};
        content[type] = media;
        if (caption) content.caption = caption;
        if (mimetype) content.mimetype = mimetype;
        if (fileName) content.fileName = fileName;

        return await this.sendMessageEnhanced(jid, content, options);
    }

    /**
     * Send interactive message (buttons, lists)
     * @param {string} jid - Target JID
     * @param {object} interactive - Interactive content
     * @param {object} options - Send options
     */
    async sendInteractive(jid, interactive, options = {}) {
        const content = {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {}
                    },
                    interactiveMessage: interactive
                }
            }
        };

        return await this.sock.sendMessage(jid, content, options);
    }
}

/**
 * Enhanced Socket Features
 * Adds utility methods to socket
 */
class EnhancedSocket {
    constructor(sock) {
        this.sock = sock;
        this.groupStatus = new EnhancedGroupStatus(sock);
        this.messaging = new EnhancedMessaging(sock);
    }

    /**
     * Get full profile picture in high quality
     * @param {string} jid - User/Group JID
     */
    async getFullProfilePicture(jid) {
        try {
            const ppUrl = await this.sock.profilePictureUrl(jid, 'image');
            const axios = require('axios');
            const response = await axios.get(ppUrl, { 
                responseType: 'arraybuffer',
                timeout: 15000 
            });
            return Buffer.from(response.data);
        } catch (error) {
            logger.warn(`[EnhancedSocket] PP fetch failed for ${jid}: ${error.message}`);
            return null;
        }
    }

    /**
     * Batch update group participants
     * @param {string} groupJid - Group JID
     * @param {array} participants - Array of participant JIDs
     * @param {string} action - Action (add, remove, promote, demote)
     * @param {number} batchSize - Batch size for processing
     */
    async batchGroupParticipantsUpdate(groupJid, participants, action, batchSize = 20) {
        const results = [];
        
        for (let i = 0; i < participants.length; i += batchSize) {
            const batch = participants.slice(i, i + batchSize);
            try {
                const result = await this.sock.groupParticipantsUpdate(groupJid, batch, action);
                results.push(...result);
            } catch (error) {
                logger.warn(`[EnhancedSocket] Batch ${i}-${i + batch.length} failed: ${error.message}`);
                results.push({ status: 'error', jid: batch, error: error.message });
            }
            
            // Delay between batches to avoid rate limiting
            if (i + batchSize < participants.length) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        return results;
    }

    /**
     * Smart group metadata fetch with caching
     * @param {string} groupJid - Group JID
     * @param {boolean} force - Force refresh
     */
    async getGroupMetadataCached(groupJid, force = false) {
        if (!this._groupMetaCache) this._groupMetaCache = new Map();
        
        const cached = this._groupMetaCache.get(groupJid);
        const now = Date.now();
        
        if (!force && cached && (now - cached.timestamp < 5 * 60 * 1000)) {
            return cached.data;
        }

        try {
            const meta = await this.sock.groupMetadata(groupJid);
            this._groupMetaCache.set(groupJid, { data: meta, timestamp: now });
            return meta;
        } catch (error) {
            // Return stale cache on error
            if (cached) return cached.data;
            throw error;
        }
    }

    /**
     * Detect if user is admin in group
     * @param {string} groupJid - Group JID
     * @param {string} userJid - User JID
     */
    async isGroupAdmin(groupJid, userJid) {
        try {
            const meta = await this.getGroupMetadataCached(groupJid);
            const normalizedUser = userJid.replace(/:\d+@/g, '@');
            const participant = meta.participants.find(p => {
                const pid = String(p.id || '').replace(/:\d+@/g, '@');
                return pid === normalizedUser;
            });
            return participant?.admin ? true : false;
        } catch (error) {
            logger.warn(`[EnhancedSocket] Admin check failed: ${error.message}`);
            return false;
        }
    }
}

/**
 * Enhance any Baileys socket with all features
 * @param {object} sock - Baileys socket instance
 * @returns {object} Enhanced socket
 */
function enhanceBaileysSocket(sock) {
    if (!sock) {
        logger.error('[BaileysEnhancer] Cannot enhance null socket');
        return sock;
    }

    // Don't enhance twice
    if (sock._enhanced) return sock;

    const enhanced = new EnhancedSocket(sock);

    // Add methods directly to socket for convenience
    sock.sendGroupStatus = enhanced.groupStatus.sendGroupStatus.bind(enhanced.groupStatus);
    sock.sendStatusToGroups = enhanced.groupStatus.sendStatusToGroups.bind(enhanced.groupStatus);
    sock.sendStyledGroupStatus = enhanced.groupStatus.sendStyledGroupStatus.bind(enhanced.groupStatus);
    
    sock.sendMessageEnhanced = enhanced.messaging.sendMessageEnhanced.bind(enhanced.messaging);
    sock.sendMediaWithProgress = enhanced.messaging.sendMediaWithProgress.bind(enhanced.messaging);
    sock.sendInteractive = enhanced.messaging.sendInteractive.bind(enhanced.messaging);
    
    sock.getFullProfilePicture = enhanced.getFullProfilePicture.bind(enhanced);
    sock.batchGroupParticipantsUpdate = enhanced.batchGroupParticipantsUpdate.bind(enhanced);
    sock.getGroupMetadataCached = enhanced.getGroupMetadataCached.bind(enhanced);
    sock.isGroupAdmin = enhanced.isGroupAdmin.bind(enhanced);

    // Mark as enhanced
    sock._enhanced = true;
    sock._enhancer = enhanced;

    logger.success('[BaileysEnhancer] Socket enhanced with all features ✓');

    return sock;
}

module.exports = {
    enhanceBaileysSocket,
    EnhancedGroupStatus,
    EnhancedMessaging,
    EnhancedSocket
};
