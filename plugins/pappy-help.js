'use strict';
// plugins/pappy-help.js — Smart paginated .help command
// Features:
//   • Cyberpunk canvas image (SVG→sharp) with owner PFP + bot stats + command modules
//   • Paginated command table using Baileys native table message format (richResponseMessage)
//   • WhatsApp inline buttons (Next / Prev) — navigation deletes old table + sends new table
//   • Button clicks are handled silently (no extra response sent)

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const sharp  = require('sharp');
const logger = require('../core/logger');
const eventBus = require('../core/eventBus');

// ─── Category config ──────────────────────────────────────────────────────────
const CATEGORY_ORDER = [
    'CORE','ADMIN','STATUS','MAGIC','BROADCAST','MEDIA',
    'MUSIC','AESTHETIC','INTEL','STEALTH','STRIKE','TRIGGERS',
    'GROWTH_ENGINE','UTILITY','SYSTEM','GENERAL',
];
const CAT_ICON = {
    CORE:'⚙️', ADMIN:'🛡️', STATUS:'📡', MAGIC:'🪄', BROADCAST:'📢',
    MEDIA:'🎬', MUSIC:'🎵', AESTHETIC:'🎨', INTEL:'🧠', STEALTH:'🥷',
    STRIKE:'⚔️', TRIGGERS:'⚡', GROWTH_ENGINE:'🌱', UTILITY:'🧰',
    SYSTEM:'💻', GENERAL:'✨',
};

// ─── Per-command usage descriptions ──────────────────────────────────────────
const CMD_USAGE = {
    '.help':'Show all commands & usage',
    '.menu':'Show full bot menu with stats',
    '.ping':'Check bot latency & uptime',
    '.status':'View system memory & node status',
    '.owner':'Show bot owner / support link',
    '.prefix':'Show the active command prefix',
    '.tts':'Convert text to voice message',
    '.video':'Download a YouTube video',
    '.song':'Search & pick music via poll',
    '.play':'Download & play a song directly',
    '.search':'Search YouTube music tracks',
    '.tourl':'Upload replied media & return URL',
    '.imgurl':'Upload replied image → URL',
    '.videourl':'Upload replied video → URL',
    '.fileurl':'Upload replied file → URL',
    '.pappy':'Show Pappy bot info & version',
    '.sudo':'Grant sudo access to a user',
    '.delsudo':'Revoke sudo from a user',
    '.queues':'View current command queues',
    '.bind':'Bind a command to a sticker',
    '.setprefix':'Change the bot command prefix',
    '.nodemode':'Set node to public / private mode',
    '.imagine':'Search Pinterest images by query',
    '.img':'Search Pinterest images (alias)',
    '.image':'Search Pinterest images (alias)',
    '.sticker':'Convert image / video to sticker',
    '.s':'Convert image to sticker (short)',
    '.tomp4':'Convert sticker/gif to video',
    '.pin':'Search Pinterest images',
    '.pinterest':'Search Pinterest images',
    '.pic':'Search images (alias for .pin)',
    '.kick':'Remove a member from the group',
    '.ban':'Ban a member from the group',
    '.warn':'Issue a warning to a member',
    '.mute':'Mute group (admins only can chat)',
    '.unmute':'Unmute the group',
    '.promote':'Promote member to group admin',
    '.demote':'Demote admin to regular member',
    '.antilink':'Toggle anti-link filter in group',
    '.antibot':'Toggle anti-bot protection',
    '.antigm':' Toggle anti-group-mention protection',
    '.antispam':'Toggle anti-spam protection',
    '.antichannel':'Toggle anti-channel message filter',
    '.antidemote':'Toggle anti-demote protection for admins',
    '.antigstatus':'Toggle anti-group-status filter',
    '.antimodes':'View all anti-system modes & actions in a table',
    '.groupinfo':'Show group details in a table (members, admins, settings)',
    '.setgroupname':'Change the group name',
    '.setgroupdesc':'Change the group description',
    '.locksettings':'Lock group info to admins only',
    '.unlocksettings':'Allow all members to edit group info',
    '.maxwarn':'Set max warnings before auto-kick (1–20)',
    '.setaction':'Set action (kick/warn/delete) for an anti feature',
    '.tag':'Tag / mention all group members',
    '.announce':'Send group announcement',
    '.delete':'Delete a bot message',
    '.gcast':'Broadcast message to all groups',
    '.godcast':'Send message to all WA statuses',
    '.magiccast':'AI-powered smart broadcast',
    '.schedulecast':'Schedule a future broadcast',
    '.loopcast':'Loop-broadcast a message',
    '.autopromote':'Auto-promote on join request',
    '.stopcast':'Stop an active broadcast loop',
    '.poll':'Create a poll in the group',
    '.vv':'View a view-once (once) message',
    '.viewonce':'View a view-once message (alias)',
    '.fakeverify':'Add fake verified badge trick',
    '.quote':'Stylishly quote a message',
    '.react':'React to a quoted message',
    '.forward':'Forward a message anonymously',
    '.gstatus':'Check current group status',
    '.updategstatus':'Update the group status',
    '.setstatus':'Set bot WhatsApp status',
    '.pstatus':'Post content to WA status',
    '.getabout':'Get a user\'s bio/about text',
    '.strike':'Strike-warn a group member',
    '.flashtag':'Rapidly mention all members',
    '.vanish':'Delete bot messages silently',
    '.addtrigger':'Add an auto-reply trigger',
    '.deltrigger':'Remove an auto-reply trigger',
    '.triggers':'List all active triggers',
    '.setnewgcstatus':'Set status for new groups',
    '.checkgcstatus':'Check group custom status',
    '.delgcstatus':'Delete a group custom status',
    '.nexus':'Nexus growth engine control',
    '.cache':'Clear bot internal cache',
    '.save':'Save replied media to your DM',
    '.ssweb':'Screenshot any website URL',
    '.updatbailey':'Update Baileys library',
    '.setsudo':'Set sudo user (system)',
    '.listsudo':'List current sudo users',
    '.restart':'Restart the bot process',
    '.invitecard':'Generate group invite card',
    '.gclink':'Get group invite link',
    '.jidlink':'Convert JID to WA link',
    '.join':'Join a group via invite link',
    '.autojoin':'Toggle auto-join on invite',
    '.joinqueue':'Add to a group join queue',
    '.scrape':'Scrape / export group members',
    '.radars':'Show active radar monitors',
    '.validnode':'Validate node connectivity',
};

// ─── Permission helper ────────────────────────────────────────────────────────
function hasPermission(userRole, requiredRole = 'owner') {
    const roles = { public: 1, admin: 2, owner: 3 };
    return (roles[userRole] || 1) >= (roles[requiredRole] || 3);
}

// ─── Scan all plugins for commands ───────────────────────────────────────────
function buildAllCommands(userRole, prefix) {
    const pluginsDir = path.join(__dirname, '../plugins');
    let files = [];
    try { files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js')); } catch {}

    const cmds = [];
    const seen = new Set();

    for (const file of files) {
        try {
            const plugin = require(path.join(pluginsDir, file));
            if (!plugin.commands) continue;
            const cat = String(plugin.category || 'GENERAL').toUpperCase();
            for (const command of plugin.commands) {
                const rawName = String(command.cmd || '').trim();
                if (!rawName) continue;
                if (!hasPermission(userRole, command.role)) continue;
                const clean = rawName.replace(/^[^a-zA-Z0-9]+/, '');
                if (!clean) continue;
                const display = `${prefix}${clean}`;
                if (seen.has(display)) continue;
                seen.add(display);
                cmds.push({
                    cmd: display,
                    usage: CMD_USAGE[`.${clean}`] || CMD_USAGE[display] || `Execute ${display}`,
                    category: cat,
                });
            }
        } catch {}
    }
    return cmds;
}

// ─── Build one scrollable table with ALL commands grouped by category ──────────
function buildFullHelpTable(cmds) {
    const catMap = {};
    const catOrder = [];
    for (const cmd of cmds) {
        if (!catMap[cmd.category]) { catMap[cmd.category] = []; catOrder.push(cmd.category); }
        catMap[cmd.category].push(cmd);
    }
    const rows = [['Command', 'Description']];
    for (const cat of catOrder) {
        const icon = CAT_ICON[cat] || '✨';
        rows.push([`${icon} ${cat}`, '────────────────']);
        for (const c of catMap[cat]) {
            rows.push([c.cmd, c.usage]);
        }
    }
    return rows;
}

// ─── Generate help banner image using SVG → sharp ────────────────────────────
async function generateHelpImage({ ownerName, userRole, nodeId, prefix, totalCmds, totalMods,
    cmdsUsed, uptimeSec, ramUsed, ramTotal, pfpUrl, pluginsDir: pDir }) {

    // Collect category → [commandNames]
    const catMap = {};
    const seenC  = new Set();
    let files2   = [];
    try { files2 = fs.readdirSync(pDir).filter(f => f.endsWith('.js')); } catch {}
    for (const file of files2) {
        try {
            const plugin = require(path.join(pDir, file));
            if (!plugin.commands) continue;
            const cat = String(plugin.category || 'GENERAL').toUpperCase();
            if (!catMap[cat]) catMap[cat] = [];
            for (const cmd of plugin.commands) {
                const rn = String(cmd.cmd || '').trim().replace(/^[^a-zA-Z0-9]+/, '');
                if (!rn || seenC.has(rn)) continue;
                seenC.add(rn);
                catMap[cat].push(rn);
            }
        } catch {}
    }
    const cats = [...new Set([...CATEGORY_ORDER, ...Object.keys(catMap)])].filter(c => catMap[c]?.length);

    // Time/uptime formatting
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
    const ramUsedMB  = Math.round(ramUsed / 1048576);
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });

    // Fetch & resize PFP (circle crop)
    let pfpBase64 = null;
    if (pfpUrl) {
        try {
            const r = await axios.get(pfpUrl, { responseType:'arraybuffer', timeout:8000 });
            const b = await sharp(Buffer.from(r.data)).resize(110,110,{fit:'cover'}).jpeg({quality:90}).toBuffer();
            pfpBase64 = b.toString('base64');
        } catch {}
    }

    const W        = 720;
    const CAT_COLS = 3;
    const CAT_W    = 222;
    const CAT_H    = 116;
    const CAT_GAPX = 6;
    const CAT_GAPY = 6;
    const CAT_ROWS = Math.ceil(cats.length / CAT_COLS);
    const CATS_Y   = 310;
    const H        = CATS_Y + CAT_ROWS * (CAT_H + CAT_GAPY) + 58;

    // Category boxes — each shows icon, name, count + up to 8 command names
    const catBoxesSvg = cats.map((cat, i) => {
        const col  = i % CAT_COLS;
        const row  = Math.floor(i / CAT_COLS);
        const bx   = 10 + col * (CAT_W + CAT_GAPX);
        const by   = CATS_Y + row * (CAT_H + CAT_GAPY);
        const icon = (CAT_ICON[cat] || '✨').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const name = cat.replace(/_/g,' ');
        const list = (catMap[cat] || []).slice(0, 8).map(c => `.${c}`);
        const extra = Math.max(0, (catMap[cat] || []).length - list.length);
        // two columns of cmds inside box
        const col1 = list.filter((_,k)=>k%2===0);
        const col2 = list.filter((_,k)=>k%2!==0);
        const cmdSvg = col1.map((c, ri) => {
            const cy2 = by + 38 + ri * 13;
            return `<text x="${bx+9}" y="${cy2}" font-family="monospace" font-size="8.5" fill="#b76fff">${c.slice(0,13)}</text>` +
                   (col2[ri] ? `<text x="${bx+118}" y="${cy2}" font-family="monospace" font-size="8.5" fill="#b76fff">${col2[ri].slice(0,13)}</text>` : '');
        }).join('');
        const moreSvg = extra > 0
            ? `<text x="${bx+9}" y="${by+38+col1.length*13}" font-family="monospace" font-size="8" fill="#6d28d9">+${extra} more</text>`
            : '';
        return `
<rect x="${bx}" y="${by}" width="${CAT_W}" height="${CAT_H}" rx="6" fill="#0e0024" stroke="#5b21b6" stroke-width="1.2"/>
<rect x="${bx}" y="${by}" width="${CAT_W}" height="24" rx="6" fill="#1a0040"/>
<rect x="${bx}" y="${by+18}" width="${CAT_W}" height="6" fill="#1a0040"/>
<rect x="${bx}" y="${by}" width="3" height="${CAT_H}" rx="2" fill="#7c3aed"/>
<text x="${bx+12}" y="${by+16}" font-family="monospace" font-weight="bold" font-size="10" fill="#c084fc">${icon} ${name}  [${(catMap[cat]||[]).length}]</text>
${cmdSvg}${moreSvg}`;
    }).join('\n');

    // PFP with circular clip + glow ring
    const PFP_CX = 76, PFP_CY = 185, PFP_R = 58;
    const pfpSvg = pfpBase64
        ? `<clipPath id="pfpClip"><circle cx="${PFP_CX}" cy="${PFP_CY}" r="${PFP_R}"/></clipPath>
           <circle cx="${PFP_CX}" cy="${PFP_CY}" r="${PFP_R+10}" fill="none" stroke="#3b0764" stroke-width="2" stroke-dasharray="5 4"/>
           <circle cx="${PFP_CX}" cy="${PFP_CY}" r="${PFP_R+4}"  fill="none" stroke="#6d28d9" stroke-width="1.5"/>
           <image x="${PFP_CX-PFP_R}" y="${PFP_CY-PFP_R}" width="${PFP_R*2}" height="${PFP_R*2}" href="data:image/jpeg;base64,${pfpBase64}" clip-path="url(#pfpClip)"/>
           <circle cx="${PFP_CX}" cy="${PFP_CY}" r="${PFP_R}" fill="none" stroke="#8b5cf6" stroke-width="2.5"/>`
        : `<circle cx="${PFP_CX}" cy="${PFP_CY}" r="${PFP_R+10}" fill="none" stroke="#3b0764" stroke-width="2" stroke-dasharray="5 4"/>
           <circle cx="${PFP_CX}" cy="${PFP_CY}" r="${PFP_R}" fill="#110228" stroke="#8b5cf6" stroke-width="2.5"/>
           <text x="${PFP_CX}" y="${PFP_CY+10}" font-size="36" text-anchor="middle" fill="#7c3aed">👤</text>`;

    // Stats — 4-col × 3-row tile grid right of PFP
    const stats = [
        { label:'COMMANDS', value: totalCmds  },
        { label:'MODULES',  value: totalMods  },
        { label:'UPTIME',   value: uptimeStr  },
        { label:'RAM USED', value:`${ramUsedMB}MB`},
        { label:'CMD USED', value: cmdsUsed   },
        { label:'PREFIX',   value:`[ ${prefix} ]`},
        { label:'NODE ID',  value: nodeId.slice(0,12) },
        { label:'TIME',     value: timeStr    },
    ];
    const TILE_W = 130, TILE_H = 52, T_COLS = 4;
    const TX0 = 155, TY0 = 100;
    const statTiles = stats.map((s, i) => {
        const c = i % T_COLS, rr = Math.floor(i / T_COLS);
        const tx = TX0 + c * (TILE_W + 5);
        const ty = TY0 + rr * (TILE_H + 5);
        return `
<rect x="${tx}" y="${ty}" width="${TILE_W}" height="${TILE_H}" rx="7" fill="#0f0125" stroke="#2e0b5e" stroke-width="1"/>
<rect x="${tx}" y="${ty}" width="${TILE_W}" height="3" rx="1" fill="#4c1d95"/>
<text x="${tx+9}" y="${ty+16}" font-family="monospace" font-size="8" fill="#5b21b6" letter-spacing="1">${s.label}</text>
<text x="${tx+9}" y="${ty+38}" font-family="monospace" font-size="15" fill="#c084fc" font-weight="bold">${String(s.value).slice(0,13)}</text>`;
    }).join('\n');

    // Grid background lines
    const gridH = Array.from({length: Math.ceil(H/40)}, (_,i) =>
        `<line x1="0" y1="${i*40}" x2="${W}" y2="${i*40}" stroke="#1a004a" stroke-width="0.35"/>`).join('');
    const gridV = Array.from({length: Math.ceil(W/40)}, (_,i) =>
        `<line x1="${i*40}" y1="0" x2="${i*40}" y2="${H}" stroke="#1a004a" stroke-width="0.35"/>`).join('');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<defs>
  <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%"   stop-color="#050010"/>
    <stop offset="55%"  stop-color="#0b001f"/>
    <stop offset="100%" stop-color="#03000d"/>
  </linearGradient>
  <linearGradient id="hdrGrad" x1="0%" y1="0%" x2="100%" y2="0%">
    <stop offset="0%"   stop-color="#12002e"/>
    <stop offset="40%"  stop-color="#260060"/>
    <stop offset="100%" stop-color="#12002e"/>
  </linearGradient>
  <linearGradient id="titleGrad" x1="0%" y1="0%" x2="100%" y2="0%">
    <stop offset="0%"   stop-color="#a855f7"/>
    <stop offset="50%"  stop-color="#f0abfc"/>
    <stop offset="100%" stop-color="#818cf8"/>
  </linearGradient>
  <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
    <stop offset="0%"   stop-color="#7c3aed"/>
    <stop offset="50%"  stop-color="#be185d"/>
    <stop offset="100%" stop-color="#7c3aed"/>
  </linearGradient>
  <filter id="glow">
    <feGaussianBlur stdDeviation="3.5" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="sglow">
    <feGaussianBlur stdDeviation="1.5" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>

<!-- BG + grid -->
<rect width="${W}" height="${H}" fill="url(#bg)"/>
${gridH}${gridV}

<!-- Outer frame -->
<rect x="2" y="2" width="${W-4}" height="${H-4}" rx="6" fill="none" stroke="#2d006b" stroke-width="2"/>
<rect x="5" y="5" width="${W-10}" height="${H-10}" rx="5" fill="none" stroke="#1a0040" stroke-width="1"/>

<!-- Header -->
<rect x="0" y="0" width="${W}" height="92" fill="url(#hdrGrad)"/>
<rect x="0" y="0" width="${W}" height="4" fill="url(#accent)"/>
<line x1="0" y1="92" x2="${W}" y2="92" stroke="#5b21b6" stroke-width="1.5"/>

<!-- Corner brackets -->
<path d="M10,2 L2,2 L2,14" fill="none" stroke="#8b5cf6" stroke-width="2"/>
<path d="M${W-10},2 L${W-2},2 L${W-2},14" fill="none" stroke="#8b5cf6" stroke-width="2"/>
<path d="M10,${H-2} L2,${H-2} L2,${H-14}" fill="none" stroke="#8b5cf6" stroke-width="2"/>
<path d="M${W-10},${H-2} L${W-2},${H-2} L${W-2},${H-14}" fill="none" stroke="#8b5cf6" stroke-width="2"/>

<!-- Status badge -->
<rect x="${W-125}" y="12" width="112" height="20" rx="10" fill="#052e16" stroke="#16a34a" stroke-width="1"/>
<circle cx="${W-111}" cy="22" r="4.5" fill="#22c55e" filter="url(#sglow)"/>
<text x="${W-102}" y="26" font-family="monospace" font-size="9" fill="#4ade80" font-weight="bold" letter-spacing="1">● ONLINE</text>

<!-- Lightning accents -->
<text x="18"      y="62" font-size="28" fill="#e879f9" filter="url(#glow)">⚡</text>
<text x="${W-50}" y="62" font-size="28" fill="#e879f9" filter="url(#glow)">⚡</text>

<!-- Title -->
<text x="${W/2}" y="50" font-family="monospace" font-weight="bold" font-size="34" fill="url(#titleGrad)" text-anchor="middle" filter="url(#glow)" letter-spacing="8">PAPPY V2</text>
<text x="${W/2}" y="68" font-family="monospace" font-size="10" fill="#9333ea" text-anchor="middle" letter-spacing="5">N E X U S   C O N T R O L   H U B</text>
<text x="${W/2}" y="83" font-family="monospace" font-size="8.5" fill="#4c1d95" text-anchor="middle" letter-spacing="3">PREMIUM WHATSAPP AUTOMATION BOT</text>

<!-- Left panel (PFP area) -->
<rect x="0" y="92" width="150" height="${CATS_Y-92}" fill="#07001a"/>
<line x1="150" y1="92" x2="150" y2="${CATS_Y}" stroke="#2d006b" stroke-width="1.5"/>
<text x="8" y="${(CATS_Y+92)/2}" font-family="monospace" font-size="8" fill="#3b0764" text-anchor="middle" transform="rotate(-90,8,${(CATS_Y+92)/2})" letter-spacing="3">PAPPY CORE</text>

<!-- PFP -->
${pfpSvg}
<text x="${PFP_CX}" y="${PFP_CY+PFP_R+16}" font-family="monospace" font-size="8.5" fill="#8b5cf6" text-anchor="middle" letter-spacing="2">OWNER</text>
<text x="${PFP_CX}" y="${PFP_CY+PFP_R+29}" font-family="sans-serif" font-size="11" fill="#c084fc" text-anchor="middle" font-weight="bold">${(ownerName||'OWNER').slice(0,13)}</text>
<rect x="18" y="${PFP_CY+PFP_R+33}" width="116" height="18" rx="9" fill="#1e0050" stroke="#6d28d9" stroke-width="1"/>
<text x="${PFP_CX}" y="${PFP_CY+PFP_R+46}" font-family="monospace" font-size="9" fill="#a78bfa" text-anchor="middle">${(userRole||'owner').toUpperCase()}</text>

<!-- Stat tiles -->
${statTiles}

<!-- COMMAND MODULES divider + label -->
<rect x="0" y="${CATS_Y-2}" width="${W}" height="3" fill="url(#accent)"/>
<rect x="${W/2-115}" y="${CATS_Y+6}" width="230" height="22" rx="11" fill="#130030" stroke="#6d28d9" stroke-width="1"/>
<text x="${W/2}" y="${CATS_Y+21}" font-family="monospace" font-weight="bold" font-size="11" fill="#c084fc" text-anchor="middle" letter-spacing="3">⚡ COMMAND MODULES ⚡</text>

<!-- Category boxes -->
${catBoxesSvg}

<!-- Footer -->
<rect x="0" y="${H-42}" width="${W}" height="42" fill="#06001a"/>
<rect x="0" y="${H-42}" width="${W}" height="1.5" fill="#2d006b"/>
<text x="18"     y="${H-24}" font-family="monospace" font-size="8.5" fill="#5b21b6">⚡ PAPPY CORE v2.0.0</text>
<text x="${W/2}" y="${H-24}" font-family="monospace" font-size="8.5" fill="#3b0764" text-anchor="middle" letter-spacing="2">STAY FAST. STAY AHEAD.</text>
<text x="${W-18}" y="${H-24}" font-family="monospace" font-size="8.5" fill="#5b21b6" text-anchor="end">t.me/pappylung</text>
<text x="${W/2}" y="${H-10}" font-family="monospace" font-size="7.5" fill="#1e0040" text-anchor="middle">[✓] FAST  [✓] SECURE  [✓] STABLE  [✓] POWERFUL</text>
</svg>`;

    return sharp(Buffer.from(svg)).png().toBuffer();
}

// ─── Plugin export ────────────────────────────────────────────────────────────
module.exports = {
    category: 'CORE',
    commands: [
        { cmd: '.help', role: 'public' },
    ],

    execute: async ({ sock, msg, args, user, botId }) => {
        const jid = msg.key.remoteJid;

        let { globalPrefix } = require('../config');
        const prefix = globalPrefix || '.';

        // Resolve effective role
        let userRole = user?.role || 'public';
        try {
            const sender = msg.key.participant || msg.key.remoteJid;
            const om = require('../modules/ownerManager');
            if (om.isOwner(sender) || om.isSudo(sender)) userRole = 'owner';
        } catch {}

        const os = require('os');
        const pluginsDir = path.join(__dirname, '../plugins');

        // Build full command list for this user's role
        const allCmds = buildAllCommands(userRole, prefix);

        if (!allCmds.length) {
            return sock.sendMessage(jid, { text: '❌ No commands available.' }, { quoted: msg });
        }

        // React to signal processing
        await sock.sendMessage(jid, { react: { text: '📋', key: msg.key } }).catch(() => {});

        // Gather stats for image banner
        const ramUsed  = os.totalmem() - os.freemem();
        const ramTotal = os.totalmem();
        const nodeId   = String(botId || sock.user?.id || '')
            .split(':')[0].split('@')[0].replace(/[^0-9]/g, '') || '—';

        // Fetch owner PFP
        let pfpUrl = null;
        try {
            const { ownerWhatsAppJids } = require('../config');
            const ownerJid = ownerWhatsAppJids?.[0] ||
                (sock.user?.id ? `${String(sock.user.id).split(':')[0].split('@')[0]}@s.whatsapp.net` : null);
            if (ownerJid) pfpUrl = await sock.profilePictureUrl(ownerJid, 'image').catch(() => null);
        } catch {}

        const allCmdsTotal = buildAllCommands('owner', prefix);
        const allCats      = [...new Set(allCmdsTotal.map(c => c.category))];

        // Generate cyberpunk help image banner
        let helpImg = null;
        try {
            helpImg = await generateHelpImage({
                ownerName:  user?.name || 'OWNER',
                userRole,
                nodeId,
                prefix,
                totalCmds:  allCmdsTotal.length,
                totalMods:  allCats.length,
                cmdsUsed:   user?.stats?.commandsUsed ?? 0,
                uptimeSec:  process.uptime(),
                ramUsed,
                ramTotal,
                pfpUrl,
                pluginsDir,
            });
        } catch (imgErr) {
            logger.warn(`[Help] Image generation failed: ${imgErr.message}`);
        }

        // Send banner image first
        if (helpImg) {
            await sock.sendMessage(jid, {
                image:      helpImg,
                caption:    `⚡ *PAPPY V2* — ${allCmds.length} commands  •  prefix \`${prefix}\`  •  scroll the table below`,
                verifiedMe: true,
            }, { quoted: msg }).catch(() => {});
        }

        // Send ONE scrollable table with all commands grouped by category
        const tableRows = buildFullHelpTable(allCmds);
        await sock.sendMessage(jid, {
            title:       '📋 PAPPY V2 — Command List',
            headerText:  `## ${allCmds.length} Commands  •  prefix: ${prefix}`,
            contentText: '─────────────────────────',
            table:       tableRows,
            noHeading:   false,
            footerText:  '⚡ Scroll up to see all commands  •  t.me/pappylung',
        }, { quoted: helpImg ? undefined : msg }).catch(() => null);
    },
};
