'use strict';
// plugins/pappy-pinterest.js — Pinterest-first image search
// Strategy: Real Pinterest RSS/search → DuckDuckGo pinimg.com priority → web fallback

const axios  = require('axios');
const logger = require('../core/logger');

const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
];
const pickUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

// ── Pinterest RSS feed (no API key) ─────────────────────────────────────────
async function searchViaPinterestRSS(query, limit = 12) {
    try {
        const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
        const res = await axios.get(url, {
            timeout: 12000,
            headers: {
                'User-Agent': pickUA(),
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.pinterest.com/',
            },
            maxRedirects: 5,
        });
        // Extract pinimg.com image URLs from the HTML source
        const raw = String(res.data || '');
        const matches = [...raw.matchAll(/"(https?:\/\/i\.pinimg\.com\/[^"]{20,}\.(?:jpg|jpeg|png|webp))"/gi)];
        const urls = [...new Set(matches.map(m => m[1]))];
        // Prefer 736x (high-res originals)
        const hd   = urls.filter(u => u.includes('/736x/') || u.includes('/originals/'));
        const rest = urls.filter(u => !hd.includes(u));
        return [...hd, ...rest].slice(0, limit).map(u => ({ imageUrl: u, title: query }));
    } catch (e) {
        logger.warn(`[Pinterest] RSS scrape failed: ${e.message}`);
        return [];
    }
}

// ── DuckDuckGo VQD token extraction (robust) ────────────────────────────────
async function getDDGToken(query) {
    const res = await axios.get('https://duckduckgo.com/', {
        params: { q: query },
        headers: { 'User-Agent': pickUA(), 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: 12000,
    });
    const body = String(res.data || '');
    const vqd = body.match(/vqd=['"]([^'"]+)['"]/)?.[1]
             || body.match(/vqd=([\d-]+)/)?.[1];
    if (!vqd) throw new Error('DDG token failed');
    return vqd;
}

async function searchViaDDG(query, limit = 12) {
    try {
        const vqd = await getDDGToken(`${query} site:pinterest.com`);
        const res = await axios.get('https://duckduckgo.com/i.js', {
            params: { l: 'us-en', o: 'json', q: `${query} site:pinterest.com`, vqd, f: ',,,,,', p: 1 },
            headers: { 'User-Agent': pickUA(), 'Referer': 'https://duckduckgo.com/' },
            timeout: 12000,
        });
        const results = res.data?.results || [];
        const pinterest = results.filter(r => r.image?.includes('pinimg.com'));
        const others    = results.filter(r => !r.image?.includes('pinimg.com'));
        return [...pinterest, ...others].slice(0, limit).map(r => ({
            imageUrl: r.image,
            title:    r.title || query,
        })).filter(r => r.imageUrl);
    } catch {
        // Fallback: plain DDG image search without site filter
        try {
            const vqd2 = await getDDGToken(query);
            const res2 = await axios.get('https://duckduckgo.com/i.js', {
                params: { l: 'us-en', o: 'json', q: query, vqd: vqd2, f: ',,,,,', p: 1 },
                headers: { 'User-Agent': pickUA(), 'Referer': 'https://duckduckgo.com/' },
                timeout: 12000,
            });
            const results2 = res2.data?.results || [];
            const pins = results2.filter(r => r.image?.includes('pinimg.com'));
            const rest = results2.filter(r => !r.image?.includes('pinimg.com'));
            return [...pins, ...rest].slice(0, limit).map(r => ({
                imageUrl: r.image,
                title: r.title || query,
            })).filter(r => r.imageUrl);
        } catch { return []; }
    }
}

// ── Master search — Pinterest RSS first, DDG fallback ───────────────────────
async function searchImages(query, limit = 10) {
    // Try Pinterest direct first (highest quality)
    let results = await searchViaPinterestRSS(query, limit + 5);
    if (results.length < 4) {
        // Supplement with DDG
        const ddg = await searchViaDDG(query, limit + 5);
        const existing = new Set(results.map(r => r.imageUrl));
        for (const r of ddg) {
            if (!existing.has(r.imageUrl)) results.push(r);
        }
    }
    return results.slice(0, limit);
}

async function downloadImage(url) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: { 'User-Agent': pickUA(), 'Referer': 'https://www.pinterest.com/' },
        maxContentLength: 25 * 1024 * 1024,
    });
    if (!(res.headers['content-type'] || '').startsWith('image/')) throw new Error('Not an image');
    return Buffer.from(res.data);
}

module.exports = {
    category: 'MEDIA',
    commands: [
        { cmd: '.pinterest', role: 'public' },
        { cmd: '.pin',       role: 'public' },
        { cmd: '.pic',       role: 'public' },
    ],

    execute: async ({ sock, msg, args }) => {
        const jid   = msg.key.remoteJid;
        const query = args.join(' ').trim();

        if (!query) {
            return sock.sendMessage(jid, {
                text: [
                    `꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦`,
                    `✿ *Pinterest Image Search*`,
                    `꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦`,
                    ``,
                    `  📌 Usage: \`.pin <query>\``,
                    `  💡 Example: \`.pin aesthetic room ideas\``,
                    ``,
                    `  Sends up to *10* HD Pinterest images`,
                ].join('\n')
            }, { quoted: msg });
        }

        const statusMsg = await sock.sendMessage(jid, {
            text: `✿ _Scanning Pinterest for_ *${query}*...`
        }, { quoted: msg });

        try {
            const results = await searchImages(query, 10);
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});

            if (!results.length) {
                return sock.sendMessage(jid, {
                    text: `❌ No Pinterest images found for *${query}*.\n_Try different keywords._`
                }, { quoted: msg });
            }

            // Download and send all images concurrently, then send in order
            const downloads = await Promise.allSettled(
                results.map(r => downloadImage(r.imageUrl).then(buf => ({ buf, title: r.title })))
            );

            let sent = 0;
            for (let i = 0; i < downloads.length; i++) {
                if (downloads[i].status !== 'fulfilled') continue;
                const { buf, title } = downloads[i].value;
                await sock.sendMessage(jid, {
                    image:      buf,
                    caption:    `📌 *${String(title || query).slice(0, 100)}*\n_${sent + 1}/${results.length} · Pinterest_`,
                    verifiedMe: true,
                }).catch(() => {});
                sent++;
                if (sent < results.length) await new Promise(r => setTimeout(r, 400));
            }

            if (sent === 0) {
                return sock.sendMessage(jid, { text: '❌ Could not download images. Try again.' }, { quoted: msg });
            }

        } catch (err) {
            logger.error(`[Pinterest] ${err.message}`);
            await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
            return sock.sendMessage(jid, { text: `❌ Search failed: ${err.message}` }, { quoted: msg });
        }
    },
};
