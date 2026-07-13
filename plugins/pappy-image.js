'use strict';
// plugins/pappy-image.js — Pinterest-powered image fetch (no AI generation)
// .imagine / .img / .image → HD Pinterest images

const axios  = require('axios');
const logger = require('../core/logger');

const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
];
const pickUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

async function getPinterestImages(query, limit = 5) {
    // Path 1: Scrape Pinterest search HTML
    try {
        const res = await axios.get(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}&rs=typed`, {
            timeout: 12000,
            headers: {
                'User-Agent': pickUA(),
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.pinterest.com/',
            },
            maxRedirects: 5,
        });
        const raw = String(res.data || '');
        const matches = [...raw.matchAll(/"(https?:\/\/i\.pinimg\.com\/[^"]{20,}\.(?:jpg|jpeg|png|webp))"/gi)];
        const urls = [...new Set(matches.map(m => m[1]))];
        const hd   = urls.filter(u => u.includes('/736x/') || u.includes('/originals/'));
        const rest = urls.filter(u => !hd.includes(u));
        const all  = [...hd, ...rest].slice(0, limit);
        if (all.length >= 2) return all.map(u => ({ imageUrl: u, title: query }));
    } catch {}

    // Path 2: DuckDuckGo with Pinterest filter
    try {
        const tokenRes = await axios.get('https://duckduckgo.com/', {
            params: { q: `${query} site:pinterest.com` },
            headers: { 'User-Agent': pickUA() },
            timeout: 10000,
        });
        const body = String(tokenRes.data || '');
        const vqd  = body.match(/vqd=['"]([^'"]+)['"]/)?.[1] || body.match(/vqd=([\d-]+)/)?.[1];
        if (!vqd) throw new Error('no token');
        const imgRes = await axios.get('https://duckduckgo.com/i.js', {
            params: { l: 'us-en', o: 'json', q: `${query} site:pinterest.com`, vqd, f: ',,,,,', p: 1 },
            headers: { 'User-Agent': pickUA(), 'Referer': 'https://duckduckgo.com/' },
            timeout: 10000,
        });
        const results = imgRes.data?.results || [];
        const pins  = results.filter(r => r.image?.includes('pinimg.com'));
        const rest2 = results.filter(r => !r.image?.includes('pinimg.com'));
        return [...pins, ...rest2].slice(0, limit).map(r => ({ imageUrl: r.image, title: r.title || query }));
    } catch {}

    return [];
}

async function downloadImage(url) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 18000,
        headers: { 'User-Agent': pickUA(), 'Referer': 'https://www.pinterest.com/' },
        maxContentLength: 20 * 1024 * 1024,
    });
    if (!(res.headers['content-type'] || '').startsWith('image/')) throw new Error('Not an image');
    return Buffer.from(res.data);
}

module.exports = {
    category: 'MEDIA',
    commands: [
        { cmd: '.imagine', role: 'public' },
        { cmd: '.img',     role: 'public' },
        { cmd: '.image',   role: 'public' },
    ],

    execute: async ({ sock, msg, args }) => {
        const jid   = msg.key.remoteJid;
        const query = args.join(' ').trim();

        if (!query) {
            return sock.sendMessage(jid, {
                text: [
                    `꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦`,
                    `✿ *Image Search*`,
                    `꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦`,
                    ``,
                    `  📌 Usage: \`.img <description>\``,
                    `  💡 Example: \`.img dark anime aesthetic\``,
                    ``,
                    `  Returns up to *5* HD Pinterest images`,
                ].join('\n')
            }, { quoted: msg });
        }

        const status = await sock.sendMessage(jid, {
            text: `✿ _Scanning Pinterest for_ *${query}*...`
        }, { quoted: msg });

        try {
            const results = await getPinterestImages(query, 5);
            await sock.sendMessage(jid, { delete: status.key }).catch(() => {});

            if (!results.length) {
                return sock.sendMessage(jid, {
                    text: `❌ No images found for *${query}*.\n_Try different keywords or use .pin for a wider search._`
                }, { quoted: msg });
            }

            // Download all in parallel, send in sequence
            const downloads = await Promise.allSettled(results.map(r => downloadImage(r.imageUrl)));
            let sent = 0;
            for (let i = 0; i < downloads.length; i++) {
                if (downloads[i].status !== 'fulfilled') continue;
                await sock.sendMessage(jid, {
                    image:      downloads[i].value,
                    caption:    `📌 *${String(query).slice(0, 80)}* — Pinterest\n_${sent + 1}/${results.length}_`,
                    verifiedMe: true,
                }).catch(() => {});
                sent++;
                if (sent < results.length) await new Promise(r => setTimeout(r, 350));
            }

            if (sent === 0) {
                return sock.sendMessage(jid, { text: '❌ Images failed to load. Try again.' }, { quoted: msg });
            }
        } catch (err) {
            logger.error(`[Image] ${err.message}`);
            await sock.sendMessage(jid, { delete: status.key }).catch(() => {});
            return sock.sendMessage(jid, { text: `❌ Failed: ${err.message}` }, { quoted: msg });
        }
    },
};
