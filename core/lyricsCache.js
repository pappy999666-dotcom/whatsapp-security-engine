'use strict';
// core/lyricsCache.js - Persistent lyrics caching with song metadata

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CACHE_FILE = path.join(__dirname, '../data/lyrics_cache.json');
const MAX_CACHE_SIZE = 10000; // 10k songs max
const CACHE_TTL = 90 * 24 * 60 * 60 * 1000; // 90 days

let cache = new Map();

function loadCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) {
            fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
            return;
        }
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        cache = new Map(Object.entries(data || {}));
        logger.info(`[LyricsCache] Loaded ${cache.size} cached lyrics`);
    } catch (err) {
        logger.warn('[LyricsCache] Failed to load cache', { error: err.message });
        cache = new Map();
    }
}

function saveCache() {
    try {
        const obj = Object.fromEntries(cache.entries());
        fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
        logger.warn('[LyricsCache] Failed to save cache', { error: err.message });
    }
}

function cleanupCache() {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, entry] of cache.entries()) {
        if (now - entry.cachedAt > CACHE_TTL) {
            cache.delete(key);
            removed++;
        }
    }
    
    if (cache.size > MAX_CACHE_SIZE) {
        const sorted = Array.from(cache.entries()).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
        const toRemove = cache.size - MAX_CACHE_SIZE;
        for (let i = 0; i < toRemove; i++) {
            cache.delete(sorted[i][0]);
            removed++;
        }
    }
    
    if (removed > 0) {
        logger.info(`[LyricsCache] Cleaned up ${removed} old entries`);
        saveCache();
    }
}

function getCacheKey(videoId, title, artist) {
    if (videoId) return `vid_${String(videoId).trim()}`;
    const t = String(title || '').trim().toLowerCase();
    const a = String(artist || '').trim().toLowerCase();
    return `song_${t}_${a}`.replace(/[^a-z0-9_]/g, '_');
}

function cacheLyrics(videoId, title, artist, lyrics, metadata = {}) {
    const key = getCacheKey(videoId, title, artist);
    cache.set(key, {
        videoId: String(videoId || ''),
        title: String(title || ''),
        artist: String(artist || ''),
        lyrics: String(lyrics || ''),
        metadata,
        cachedAt: Date.now(),
    });
    
    if (cache.size % 100 === 0) saveCache();
}

function getCachedLyrics(videoId, title, artist) {
    const key = getCacheKey(videoId, title, artist);
    const entry = cache.get(key);
    
    if (!entry) return null;
    
    if (Date.now() - entry.cachedAt > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    
    return {
        lyrics: entry.lyrics,
        title: entry.title,
        artist: entry.artist,
        metadata: entry.metadata || {},
    };
}

function searchCache(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    
    const results = [];
    for (const [key, entry] of cache.entries()) {
        const titleMatch = entry.title.toLowerCase().includes(q);
        const artistMatch = entry.artist.toLowerCase().includes(q);
        if (titleMatch || artistMatch) {
            results.push({
                title: entry.title,
                artist: entry.artist,
                videoId: entry.videoId,
                hasLyrics: !!entry.lyrics,
            });
        }
        if (results.length >= 20) break;
    }
    
    return results;
}

function getStats() {
    return {
        totalCached: cache.size,
        oldestEntry: Math.min(...Array.from(cache.values()).map(e => e.cachedAt)),
        newestEntry: Math.max(...Array.from(cache.values()).map(e => e.cachedAt)),
    };
}

// Initialize
loadCache();
setInterval(cleanupCache, 60 * 60 * 1000); // Cleanup every hour
setInterval(saveCache, 5 * 60 * 1000); // Save every 5 minutes

module.exports = {
    cacheLyrics,
    getCachedLyrics,
    searchCache,
    getStats,
};
