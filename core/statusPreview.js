'use strict';
// core/statusPreview.js — single source of truth for WhatsApp group-status link previews.
//
// WhatsApp group status (groupStatus:true) renders an externalAdReply card, but it ONLY
// shows an image when handed a jpegThumbnail *buffer*. A remote thumbnailUrl is ignored
// on status (it works in normal chat, not on the status ring). Every older code path
// mixed these up, which is why status cards came out blank or with a tiny inline preview.
//
// This module resolves a status-ready card through one clean 3-tier fallback and ALWAYS
// returns a large jpegThumbnail buffer, so a link status can never come out empty:
//
//   Tier 1 — EXACT AS SENT : reuse the preview the user already attached to the message
//                            (current/quoted contextInfo) or learned earlier from a
//                            message the user previously sent (preview-hint cache).
//   Tier 2 — CACHE         : reuse a card we built before (status-card cache) or the
//                            command-triggered linkPreviewCache — covers the case where
//                            the link had no preview attached when the command was sent.
//   Tier 3 — SYSTEM BUILD  : fetch WhatsApp group invite art, or scrape OG/oEmbed, and as
//                            a final guarantee synthesize a branded placeholder thumbnail.

const logger = require('./logger');
const {
    extractUrls,
    fetchImageBuffer,
    normalizeThumbnailBuffer,
    buildLinkPreview,
    getPreviewHintAsync,
} = require('./linkPreview');
const linkPreviewCache = require('./linkPreviewCache');

// ── Built-card cache (in-process Map + Redis) ────────────────────────────────
const _mem = new Map();
const MEM_MAX = 800;
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

function _redis() { try { return require('../services/redis').connection; } catch { return null; } }

function _reviveBuffer(v) {
    if (!v) return null;
    if (Buffer.isBuffer(v)) return v.length ? v : null;
    // Baileys decodes protobuf byte fields as Uint8Array — must handle before the
    // {type,data} check because Uint8Array does not have a .type property.
    if (v instanceof Uint8Array) { const b = Buffer.from(v); return b.length ? b : null; }
    if (v.type === 'Buffer' && Array.isArray(v.data)) { const b = Buffer.from(v.data); return b.length ? b : null; }
    if (typeof v === 'string' && v.length > 32) { try { const b = Buffer.from(v, 'base64'); return b.length ? b : null; } catch { return null; } }
    return null;
}

function _normKey(url) { return String(url || '').trim().toLowerCase(); }

async function _cacheGet(url) {
    const k = _normKey(url);
    const hit = _mem.get(k);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.card;
    if (hit) _mem.delete(k);
    const r = _redis();
    if (r) {
        try {
            const raw = await r.get(`spc:${k}`);
            if (raw) {
                const p = JSON.parse(raw);
                const thumb = _reviveBuffer(p.thumbB64);
                if (thumb) {
                    const card = { title: p.title || '', body: p.body || '', sourceUrl: p.sourceUrl || url, jpegThumbnail: thumb };
                    _mem.set(k, { card, ts: Date.now() });
                    return card;
                }
            }
        } catch {}
    }
    return null;
}

async function _cacheSet(url, card) {
    if (!card || !Buffer.isBuffer(card.jpegThumbnail) || !card.jpegThumbnail.length) return;
    const k = _normKey(url);
    _mem.set(k, { card, ts: Date.now() });
    if (_mem.size > MEM_MAX) { const first = _mem.keys().next().value; _mem.delete(first); }
    const r = _redis();
    if (r) {
        try {
            await r.set(`spc:${k}`, JSON.stringify({
                title: card.title || '',
                body: card.body || '',
                sourceUrl: card.sourceUrl || url,
                thumbB64: card.jpegThumbnail.toString('base64'),
            }), 'EX', Math.floor(TTL_MS / 1000));
        } catch {}
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _waCode(url) {
    const m = String(url || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    return m ? m[1] : null;
}

function _hostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Link'; }
}

// A "candidate" is the loose shape { title, body, sourceUrl, thumb(Buffer|null), thumbUrl(string|null) }.

// Tier 1 — read whatever preview the message already carried.
function _fromInline(sourceMessage, sourceContextInfo) {
    const cand = { title: '', body: '', sourceUrl: '', thumb: null, thumbUrl: null };
    const ext = sourceMessage?.extendedTextMessage || null;
    const ctx = sourceContextInfo || ext?.contextInfo || null;
    const ad = ctx?.externalAdReply || null;
    if (ad) {
        cand.title = ad.title || '';
        cand.body = ad.body || ad.description || '';
        cand.sourceUrl = ad.sourceUrl || ad.mediaUrl || '';
        cand.thumb = _reviveBuffer(ad.jpegThumbnail);
        if (!cand.thumb && ad.thumbnailUrl) cand.thumbUrl = ad.thumbnailUrl;
    }
    if (ext) {
        cand.title = cand.title || ext.title || '';
        cand.body = cand.body || ext.description || '';
        cand.sourceUrl = cand.sourceUrl || ext.canonicalUrl || ext.matchedText || '';
        if (!cand.thumb) cand.thumb = _reviveBuffer(ext.jpegThumbnail);
    }
    return cand;
}

// Tier 1c — preview-hint cache returns a full contextInfo (what the user's WA generated).
function _fromContextInfo(ctx) {
    if (!ctx?.externalAdReply) return null;
    const ad = ctx.externalAdReply;
    return {
        title: ad.title || '',
        body: ad.body || ad.description || '',
        sourceUrl: ad.sourceUrl || ctx['matched-text'] || ctx.matchedText || '',
        thumb: _reviveBuffer(ad.jpegThumbnail),
        thumbUrl: ad.thumbnailUrl || null,
    };
}

// Tier 2 — linkPreviewCache stores a message-shaped preview entry.
function _fromLinkCache(entry) {
    const p = entry?.preview;
    if (!p) return null;
    return {
        title: p.title || '',
        body: p.body || p.description || '',
        sourceUrl: p.sourceUrl || p.canonicalUrl || p.matchedText || '',
        thumb: _reviveBuffer(p.jpegThumbnail),
        thumbUrl: p.thumbnailUrl || null,
    };
}

// Tier 3 — live WhatsApp group invite art (best quality for chat.whatsapp.com links).
async function _fromWaInvite(sock, url) {
    const code = _waCode(url);
    if (!code || !sock?.groupGetInviteInfo) return null;
    try {
        const info = await sock.groupGetInviteInfo(code);
        if (!info?.id) return null;
        let thumb = null;
        try {
            // Try to get highest quality profile picture available
            // 'image' gives higher res than 'preview'
            const ppUrl = await sock.profilePictureUrl(info.id, 'image').catch(() => 
                sock.profilePictureUrl(info.id, 'preview')
            );
            if (ppUrl) {
                thumb = await fetchImageBuffer(ppUrl);
                // If thumbnail is still small/blurry, that's the best WA has
                logger.debug(`[StatusPreview] Fetched WA group pic: ${thumb?.length || 0} bytes`);
            }
        } catch {}
        const members = info.size || info.participants?.length || 0;
        return {
            title: info.subject || 'WhatsApp Group',
            body: info.desc || info.description || (members ? `${members} members · tap to join` : 'Tap to join'),
            sourceUrl: `https://chat.whatsapp.com/${code}`,
            thumb,
            thumbUrl: null,
        };
    } catch (e) {
        logger.warn(`[StatusPreview] WA invite resolve failed: ${e.message}`);
        return null;
    }
}

// Tier 3 — generic scrape / platform oEmbed (returns a buffer thumbnail via forGroupStatus=true).
async function _fromSystemBuild(text) {
    try {
        const built = await buildLinkPreview(text, true); // forGroupStatus → { url, title, description, thumbnail(Buffer) }
        if (!built) return null;
        return {
            title: built.title || '',
            body: built.description || '',
            sourceUrl: built.url || '',
            thumb: _reviveBuffer(built.thumbnail),
            thumbUrl: built.thumbnailUrl || null,
        };
    } catch (e) {
        logger.warn(`[StatusPreview] system build failed: ${e.message}`);
        return null;
    }
}

// Minimal valid JPEG (8×8 teal square) as a pure-JS fallback thumbnail.
// Used when sharp is not installed so the status card ALWAYS has a jpegThumbnail
// buffer — WhatsApp group status requires one or the message renders as plain text.
const _FALLBACK_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH' +
    'BwYIDAoMCwsKCwsNCxAQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQME' +
    'BAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' +
    'FBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUH' +
    '/8QAIhAAAgICAwADAQAAAAAAAAAAAQIDBAUREiExBhP/xAAUAQEAAAAAAAAAAAAAAAAA' +
    'AAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aqq3lqO3sOp2m5bv5' +
    'L1ry3ZZOcpCJNREQFfZkSyWSnPPN5SvNTnlpymX0VJNl55+uKiImYiJiJ/9k=',
    'base64'
);

// Final guarantee — a branded placeholder so the card always renders at full size.
async function _placeholderThumb(label) {
    // Try sharp first for a nice 1024×1024 branded card
    try {
        const sharp = require('sharp');
        const initial = String(label || '').trim().charAt(0).toUpperCase() || '✦';
        const svg = Buffer.from(
            `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
               <defs>
                 <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                   <stop offset="0%" stop-color="#0f766e"/>
                   <stop offset="100%" stop-color="#042f2e"/>
                 </linearGradient>
               </defs>
               <rect width="1024" height="1024" fill="url(#g)"/>
               <text x="50%" y="50%" dy="0.36em" text-anchor="middle"
                     font-family="DejaVu Sans, Arial, sans-serif" font-size="520"
                     font-weight="700" fill="#ffffff" fill-opacity="0.92">${initial}</text>
             </svg>`
        );
        return await sharp(svg).jpeg({ quality: 88 }).toBuffer();
    } catch {}
    try {
        const sharp = require('sharp');
        return await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 15, g: 118, b: 110 } } })
            .jpeg({ quality: 85 }).toBuffer();
    } catch {}
    // Pure-JS fallback — no sharp needed. Always ensures jpegThumbnail is present
    // so WA renders the link card instead of plain text.
    return _FALLBACK_JPEG;
}

/**
 * resolveStatusPreview — produce a status-ready externalAdReply with a large jpegThumbnail buffer.
 *
 * @param {Object}  args
 * @param {Object}  args.sock                 connected Baileys socket (for WA invite art)
 * @param {string}  args.text                 the text being posted (may be aesthetic-wrapped; the URL is extracted)
 * @param {Object} [args.sourceMessage]       the relayed source message (extendedTextMessage), if any
 * @param {Object} [args.sourceContextInfo]   pre-built contextInfo, if any
 * @returns {Promise<{ externalAdReply:Object, matchedText:string, canonicalUrl:string } | null>}
 */
async function resolveStatusPreview({ sock, text, sourceMessage = null, sourceContextInfo = null } = {}) {
    const urls = extractUrls(String(text || ''));
    if (!urls.length) return null; // no link → caller posts a plain text/font status
    const url = urls[0];

    const best = { title: '', body: '', sourceUrl: url };
    let thumb = null; // the final, normalized large buffer

    // Fill only the gaps in title/body/sourceUrl — the highest-priority tier that has each wins.
    const addMeta = (cand) => {
        if (!cand) return;
        if (!best.title && cand.title) best.title = cand.title;
        if (!best.body && cand.body) best.body = cand.body;
        if (!best.sourceUrl && cand.sourceUrl) best.sourceUrl = cand.sourceUrl;
    };
    // Turn a candidate's image (buffer first, else url) into a normalized large buffer.
    const tryThumb = async (cand) => {
        if (thumb || !cand) return;
        if (cand.thumb) { const n = await normalizeThumbnailBuffer(cand.thumb).catch(() => null); if (n) { thumb = n; return; } }
        if (cand.thumbUrl) {
            const fetched = await fetchImageBuffer(cand.thumbUrl).catch(() => null);
            if (fetched) { const n = await normalizeThumbnailBuffer(fetched).catch(() => null); if (n) { thumb = n; } }
        }
    };
    // We can stop walking tiers once we have BOTH an image and a title.
    const done = () => !!thumb && !!best.title;

    // ── Tier 1 — EXACT AS SENT (inline preview on the message) ──
    try { const inline = _fromInline(sourceMessage, sourceContextInfo); addMeta(inline); await tryThumb(inline); } catch {}

    // ── Tier 1c — preview-hint cache (the card the user's WA generated earlier for this link) ──
    if (!done()) { try { const hint = _fromContextInfo(await getPreviewHintAsync(String(text || ''))); addMeta(hint); await tryThumb(hint); } catch {} }

    // ── Tier 2 — our previously-built status card (covers fan-out + "no preview when sent") ──
    if (!done()) {
        try {
            const cached = await _cacheGet(url);
            if (cached) { addMeta(cached); if (!thumb && Buffer.isBuffer(cached.jpegThumbnail)) thumb = cached.jpegThumbnail; }
        } catch {}
    }

    // ── Tier 2b — command-triggered linkPreviewCache ──
    if (!done()) { try { const c = _fromLinkCache(linkPreviewCache.getCached(url)); addMeta(c); await tryThumb(c); } catch {} }

    // ── Tier 3 — SYSTEM BUILD (WhatsApp invite art, then generic OG/oEmbed scrape) ──
    if (!done() && _waCode(url)) { try { const w = await _fromWaInvite(sock, url); addMeta(w); await tryThumb(w); } catch {} }
    if (!done()) { try { const b = await _fromSystemBuild(String(text || '')); addMeta(b); await tryThumb(b); } catch {} }

    // ── Final guarantee — branded placeholder so the card is never blank ──
    if (!thumb) thumb = await _placeholderThumb(best.title || _hostname(url));

    const title = (best.title || _hostname(url)).slice(0, 100);
    const body = (best.body || url).slice(0, 200);
    const sourceUrl = best.sourceUrl || url;

    const externalAdReply = {
        title,
        body,
        mediaType: 1,
        sourceUrl,
        renderLargerThumbnail: true,
        showAdAttribution: false,
    };
    if (thumb && thumb.length) externalAdReply.jpegThumbnail = thumb;

    // Cache the built card so the rest of a fan-out (godcast to N groups) reuses it instantly.
    if (thumb && thumb.length) {
        _cacheSet(url, { title, body, sourceUrl, jpegThumbnail: thumb }).catch(() => {});
    }

    return { externalAdReply, matchedText: url, canonicalUrl: sourceUrl };
}

module.exports = { resolveStatusPreview };
