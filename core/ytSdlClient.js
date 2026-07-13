'use strict';
// core/ytSdlClient.js — optional adapter for @zeppeliorg/yt-sdl.
// The package is loaded lazily so local syntax checks and deployments without
// node_modules still boot; when installed it becomes the primary YouTube
// search/download engine for WhatsApp and Telegram.

let cachedModule;

function getYtSdl() {
    if (cachedModule) return cachedModule;
    cachedModule = require('@zeppeliorg/yt-sdl');
    return cachedModule;
}

function unwrap(mod) {
    return mod?.default || mod;
}

function pickFunction(obj, names) {
    for (const name of names) {
        if (typeof obj?.[name] === 'function') return obj[name].bind(obj);
    }
    return null;
}

function normalizeDuration(value) {
    if (!value) return '?';
    if (typeof value === 'string') return value;
    const secs = Number(value?.seconds || value || 0);
    return secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?';
}

function normalizeResult(item) {
    if (!item) return null;
    const videoId = item.videoId || item.id || item.video_id || item.videoID || item.url?.match(/[?&]v=([^&]+)/)?.[1] || item.url?.match(/youtu\.be\/([^?&]+)/)?.[1];
    if (!videoId) return null;
    return {
        videoId,
        title: item.title || item.name || 'Unknown',
        uploader: item.uploader || item.author || item.channel || item.channelName || 'Unknown',
        durationSecs: Number(item.durationSecs || item.duration_seconds || item.seconds || item.duration?.seconds || 0),
        duration: normalizeDuration(item.duration || item.durationSecs || item.duration_seconds || item.seconds),
        thumbnail: item.thumbnail || item.thumb || item.image || item.thumbnails?.[0]?.url || item.thumbnailUrl || null,
        url: item.url || `https://www.youtube.com/watch?v=${videoId}`,
    };
}

function normalizeBufferPayload(payload, fallbackMime, fallbackExt) {
    const source = payload?.buffer || payload?.data || payload?.file || payload?.stream || payload;
    if (Buffer.isBuffer(source)) {
        return {
            buffer: source,
            mimetype: payload?.mimetype || payload?.mimeType || fallbackMime,
            fileExt: payload?.fileExt || payload?.ext || fallbackExt,
            title: payload?.title,
            uploader: payload?.uploader || payload?.author,
            duration: normalizeDuration(payload?.duration || payload?.durationSecs),
            thumb: payload?.thumb || payload?.thumbnail,
        };
    }
    return null;
}

async function search(query, limit = 5) {
    const api = unwrap(getYtSdl());
    if (!api) throw new Error('@zeppeliorg/yt-sdl is not installed');
    const fn = pickFunction(api, ['search', 'ytSearch', 'youtubeSearch', 'searchYoutube', 'yts']);
    if (!fn) throw new Error('@zeppeliorg/yt-sdl search API not found');
    const raw = await fn(String(query || '').trim(), limit);
    const list = Array.isArray(raw) ? raw : (raw?.videos || raw?.results || raw?.items || raw?.data || []);
    return list.map(normalizeResult).filter(Boolean).slice(0, limit);
}

async function download(videoIdOrUrl, type = 'audio') {
    const api = unwrap(getYtSdl());
    if (!api) throw new Error('@zeppeliorg/yt-sdl is not installed');
    const url = String(videoIdOrUrl || '').startsWith('http')
        ? String(videoIdOrUrl)
        : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
    const names = type === 'video'
        ? ['downloadVideo', 'video', 'mp4', 'download']
        : ['downloadAudio', 'audio', 'mp3', 'download'];
    const fn = pickFunction(api, names);
    if (!fn) throw new Error(`@zeppeliorg/yt-sdl ${type} download API not found`);
    const raw = await fn(url, type);
    const normalized = normalizeBufferPayload(raw, type === 'video' ? 'video/mp4' : 'audio/mpeg', type === 'video' ? 'mp4' : 'mp3');
    if (!normalized?.buffer) throw new Error('@zeppeliorg/yt-sdl returned no media buffer');
    return normalized;
}

module.exports = { search, download, getYtSdl };
