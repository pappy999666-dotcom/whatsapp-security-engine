'use strict';
// core/linkPreviewCache.js — WhatsApp Link Preview Cache System
// Caches link previews from WhatsApp messages ONLY when used in commands
// NOT automatic - only caches when user sends preview with a command

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Convert any buffer-like value (Uint8Array from Baileys protobuf, {type,data}, Buffer, base64)
// to a proper Node.js Buffer so it survives JSON round-trips and _reviveBuffer checks.
function _toBuffer(v) {
    if (!v) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
    if (typeof v === 'string' && v.length > 32) { try { return Buffer.from(v, 'base64'); } catch { return null; } }
    return null;
}

const CACHE_FILE = path.join(__dirname, '../data/link_preview_cache.json');
const MAX_CACHE_SIZE = 5000;
const CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year - persistent cache

let _cache = new Map();
let _savePending = false;

// Load cache from disk
function _load() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            const now = Date.now();
            for (const [url, entry] of Object.entries(data)) {
                if (now - entry.cachedAt < CACHE_TTL_MS) {
                    _cache.set(url, entry);
                }
            }
            logger.info(`[LinkPreviewCache] Loaded ${_cache.size} cached previews`);
        }
    } catch (e) {
        logger.warn(`[LinkPreviewCache] Failed to load cache: ${e.message}`);
    }
}

// Save cache to disk
async function _save() {
    if (_savePending) return;
    _savePending = true;
    
    setTimeout(async () => {
        try {
            const obj = {};
            for (const [url, entry] of _cache.entries()) {
                obj[url] = entry;
            }
            const tmp = `${CACHE_FILE}.tmp`;
            await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2));
            await fs.promises.rename(tmp, CACHE_FILE);
        } catch (e) {
            logger.warn(`[LinkPreviewCache] Failed to save cache: ${e.message}`);
        } finally {
            _savePending = false;
        }
    }, 500);
}

// Extract URLs from text
function _extractUrls(text) {
    if (!text) return [];
    const matches = text.match(/https?:\/\/[^\s<>"']+/g) || [];
    return [...new Set(matches)];
}

// Extract link preview data from WhatsApp message
function _extractPreviewFromMessage(msg) {
    if (!msg?.message) return null;
    
    const ext = msg.message.extendedTextMessage;
    if (!ext) return null;
    
    const ctx = ext.contextInfo;
    if (!ctx) return null;
    
    // Check for externalAdReply (link preview format 1)
    if (ctx.externalAdReply) {
        const reply = ctx.externalAdReply;
        return {
            type: 'externalAdReply',
            title: reply.title || '',
            body: reply.body || '',
            sourceUrl: reply.sourceUrl || ctx['matched-text'] || ext.matchedText || '',
            thumbnailUrl: reply.thumbnailUrl || null,
            // _toBuffer converts Uint8Array (Baileys protobuf output) to proper Buffer
            // so it survives JSON serialisation and _reviveBuffer on read-back.
            jpegThumbnail: _toBuffer(reply.jpegThumbnail) || null,
            mediaType: reply.mediaType || 1,
            renderLargerThumbnail: reply.renderLargerThumbnail || true,
            showAdAttribution: reply.showAdAttribution || false,
        };
    }
    
    // Check for native link preview (matchedText format)
    if (ext.matchedText || ctx['matched-text']) {
        return {
            type: 'nativePreview',
            title: ctx.title || ext.title || '',
            description: ctx.description || ext.description || '',
            matchedText: ext.matchedText || ctx['matched-text'] || '',
            canonicalUrl: ext.canonicalUrl || ctx['canonical-url'] || ext.matchedText || ctx['matched-text'] || '',
            jpegThumbnail: _toBuffer(ctx.jpegThumbnail || ext.jpegThumbnail) || null,
        };
    }
    
    return null;
}

/**
 * Cache a link preview from a WhatsApp message (manual/command-triggered only)
 * @param {Object} msg - WhatsApp message object
 * @param {string} text - Message text content
 * @param {Object} opts - Options: { force: boolean }
 * @returns {Object|null} - { url, cached: boolean, updated: boolean }
 */
function cacheFromMessage(msg, text, opts = {}) {
    try {
        const urls = _extractUrls(text);
        if (!urls.length) return { cached: false, reason: 'no_url' };
        
        const preview = _extractPreviewFromMessage(msg);
        if (!preview) return { cached: false, reason: 'no_preview' };
        
        const url = urls[0]; // Cache first URL in message
        const existing = _cache.get(url);
        const isUpdate = !!existing;
        
        // Update cache entry
        _cache.set(url, {
            url,
            preview,
            text: text || '',
            cachedAt: Date.now(),
            source: 'command_triggered',
            updatedCount: (existing?.updatedCount || 0) + 1,
        });
        
        // Enforce cache size limit (LRU eviction)
        if (_cache.size > MAX_CACHE_SIZE) {
            const firstKey = _cache.keys().next().value;
            _cache.delete(firstKey);
        }
        
        logger.info(`[LinkPreviewCache] ${isUpdate ? 'Updated' : 'Cached'} preview for: ${url.slice(0, 60)}`);
        
        _save();
        
        return { url, cached: true, updated: isUpdate, preview };
    } catch (e) {
        logger.warn(`[LinkPreviewCache] Failed to cache preview: ${e.message}`);
        return { cached: false, reason: 'error', error: e.message };
    }
}

/**
 * Get cached preview for a URL
 * @param {string} url - URL to look up
 * @returns {Object|null} - Cached preview object or null
 */
function getCached(url) {
    if (!url) return null;
    
    const entry = _cache.get(url);
    if (!entry) return null;
    
    // Check if expired
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
        _cache.delete(url);
        _save();
        return null;
    }
    
    return entry;
}

/**
 * Get cached preview from text (extracts URL and looks up)
 * @param {string} text - Text containing URL
 * @returns {Object|null} - Cached preview object or null
 */
function getCachedFromText(text) {
    const urls = _extractUrls(text);
    if (!urls.length) return null;
    return getCached(urls[0]);
}

/**
 * Build context info from cached preview for use in sendMessage
 * @param {Object} cachedEntry - Cached entry from getCached()
 * @param {Array} mentions - Optional mentionedJid array
 * @returns {Object} - contextInfo object ready for sendMessage
 */
function buildContextInfo(cachedEntry, mentions = []) {
    if (!cachedEntry?.preview) return null;
    
    const { preview } = cachedEntry;
    
    if (preview.type === 'externalAdReply') {
        return {
            externalAdReply: {
                title: preview.title,
                body: preview.body,
                sourceUrl: preview.sourceUrl,
                thumbnailUrl: preview.thumbnailUrl,
                jpegThumbnail: preview.jpegThumbnail,
                mediaType: preview.mediaType,
                renderLargerThumbnail: preview.renderLargerThumbnail,
                showAdAttribution: preview.showAdAttribution,
            },
            mentionedJid: mentions,
        };
    }
    
    if (preview.type === 'nativePreview') {
        return {
            title: preview.title,
            description: preview.description,
            'matched-text': preview.matchedText,
            'canonical-url': preview.canonicalUrl,
            jpegThumbnail: preview.jpegThumbnail,
            mentionedJid: mentions,
        };
    }
    
    return null;
}

/**
 * Clear cache for a specific URL or all cache
 * @param {string|null} url - URL to clear, or null for all
 * @returns {boolean} - Success
 */
function clearCache(url = null) {
    if (url) {
        const deleted = _cache.delete(url);
        if (deleted) _save();
        return deleted;
    }
    _cache.clear();
    _save();
    return true;
}

/**
 * Get all cached URLs
 * @returns {Array} - Array of cached URLs with metadata
 */
function listCached() {
    const list = [];
    for (const [url, entry] of _cache.entries()) {
        list.push({
            url: url.slice(0, 80),
            cachedAt: entry.cachedAt,
            age: Math.floor((Date.now() - entry.cachedAt) / (24 * 60 * 60 * 1000)),
            updates: entry.updatedCount || 1,
            hasThumb: !!(entry.preview?.thumbnailUrl || entry.preview?.jpegThumbnail),
        });
    }
    return list.sort((a, b) => b.cachedAt - a.cachedAt);
}

/**
 * Get cache statistics
 * @returns {Object} - Cache stats
 */
function getStats() {
    return {
        size: _cache.size,
        maxSize: MAX_CACHE_SIZE,
        ttlDays: Math.floor(CACHE_TTL_MS / (24 * 60 * 60 * 1000)),
    };
}

// Initialize cache on load
_load();

module.exports = {
    cacheFromMessage,
    getCached,
    getCachedFromText,
    buildContextInfo,
    getStats,
    clearCache,
    listCached,
};
