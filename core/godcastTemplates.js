'use strict';
/**
 * godcastTemplates.js  —  Procedural Theme Engine v2.0
 * ═══════════════════════════════════════════════════════
 *
 * Replaces static template arrays with a deterministic, seed-based
 * procedural generator. Each group receives one seed; that seed
 * reproduces the exact same design forever. Changing the template
 * simply generates a new seed.
 *
 * Public API  (fully backward-compatible):
 *   renderGodcastTemplate({ groupJid, inviteLink, templateIndex, theme })
 *   assignGroupTemplate(groupJid, idx, theme)
 *   resetGroupTemplate(groupJid)
 *   getActiveTheme()
 *   setActiveTheme(theme)
 *   getTemplateIndexForGroup(groupJid, theme)
 *
 * Themes: cyber · girly · guys · gothic · kawaii · yami
 *         vampire · angel · webcore · dark · prestige
 *
 * Performance: sub-1 ms per render, zero I/O on hot path.
 * Assets preloaded once at boot; all arrays frozen in-place.
 */

const fs   = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════
// §1  STORAGE
// ══════════════════════════════════════════════════════════════════════

const STORE_FILE = path.join(__dirname, '../data/godcast-group-templates.json');
const THEME_FILE = path.join(__dirname, '../data/godcast-theme.json');

let _store      = {};
let _activeTheme = 'cyber';

function _loadStore() {
    try {
        if (fs.existsSync(STORE_FILE))
            _store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) || {};
    } catch { _store = {}; }
}
function _loadTheme() {
    try {
        if (fs.existsSync(THEME_FILE))
            _activeTheme = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8')).theme || 'cyber';
    } catch {}
}

let _saveTimer = null;
function _saveStore() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        try {
            fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
            fs.writeFileSync(STORE_FILE, JSON.stringify(_store, null, 2));
        } catch {}
    }, 800);
    if (_saveTimer?.unref) _saveTimer.unref();
}
function _saveTheme() {
    try {
        fs.mkdirSync(path.dirname(THEME_FILE), { recursive: true });
        fs.writeFileSync(THEME_FILE, JSON.stringify({ theme: _activeTheme }, null, 2));
    } catch {}
}

_loadStore();
_loadTheme();

// ══════════════════════════════════════════════════════════════════════
// §2  SEED UTILITIES
// ══════════════════════════════════════════════════════════════════════

/**
 * Mulberry32 — fast, high-quality 32-bit seeded PRNG.
 * Returns a closure that produces [0, 1) floats.
 * @param {number} seed
 * @returns {() => number}
 */
function _prng(seed) {
    let s = seed >>> 0;
    return function next() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Pick one element at random using the PRNG. */
function _pick(rng, arr) {
    return arr[(rng() * arr.length) | 0];
}

/**
 * djb2 — stable, fast string hash → positive 32-bit integer.
 * Used to derive a deterministic seed from a groupJid+theme key.
 */
function _hashSeed(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++)
        h = (((h << 5) + h) + str.charCodeAt(i)) | 0;
    return (Math.abs(h) || 1);
}

/** Create a fresh random seed (used when .settemplate is called without an index). */
function _newSeed() {
    return (_hashSeed(Date.now().toString(36) + Math.random().toString(36))) & 0x7FFFFFFF || 1;
}

// ══════════════════════════════════════════════════════════════════════
// §3  ASSET LIBRARY
// ══════════════════════════════════════════════════════════════════════
// Each theme is a self-contained pack of assets.
// Adding a new theme = adding one key here. No other code changes needed.
// All arrays are Object.freeze-d at the bottom of this section.

const ASSETS = {

    // ─────────────────────────────────────────────────────────────────
    // CYBER  —  Hacker / terminal / darknet aesthetic
    // ─────────────────────────────────────────────────────────────────
    cyber: {
        styles: ['uppercase'],
        emojis: ['🔐','🔓','⚡','🌐','📡','💀','☠','👁','🔑','🕳','💾','🛡','🚨','🔏','🐛','🧰','🔍','🖥','⌨','📟','🔴','☢','💻','📶','🧬','⚗'],
        headers: [
            'SYSTEM BREACH INITIATED','NEURAL UPLINK ONLINE','ENCRYPTED CHANNEL OPEN',
            'DARK SIGNAL LIVE','ROOT ACCESS DROPPING','PAYLOAD DELIVERED',
            'CYBER GRID UNLOCKED','DARKNET COORDINATES','SIGNAL INTERCEPTED',
            'ZERO-DAY EXPLOIT','SHADOW DROP LIVE','PACKET INCOMING',
            'SECURE TUNNEL OPEN','VPN COORDINATES','DATA VAULT CRACKED',
            'STEALTH MODE ON','KILLSWITCH ARMED','ANOMALY DETECTED',
            'EXPLOIT CHAIN LIVE','SECURE DROP INCOMING','RECON COMPLETE',
            'NODE DISCOVERED','FREQUENCY LOCKED IN','DEEP SCAN COMPLETE',
            'INTRUSION ALERT','RSA KEY TRANSMITTED','MIDNIGHT SIGNAL DROP',
            'BACKDOOR DISCOVERED','SKELETON KEY ISSUED','DEEP WEB ACCESS',
            'SYSTEM REBOOTING','BLACK HAT EXCLUSIVE','RED TEAM CHANNEL',
            'FIREWALL BYPASSED','OVERFLOW INCOMING','GHOST PROTOCOL ACTIVE',
            'CIPHER LOCK BROKEN','TRACEROUTE COMPLETE','BINARY INCOMING',
            'EXPLOIT KIT DEPLOYED','DARK OPS INITIATED','WORM DEPLOYED',
            'CLASSIFIED DROP','FREQUENCY JAMMED','SILENT OPERATION',
            'DEEP WEB ACCESS','PING RESPONSE RECEIVED','SUDO ACCESS GRANTED',
        ],
        footers: [
            'ACCESS GRANTED ↵','DECODE BEFORE TIMEOUT','SYNC OR MISS OUT',
            'AUTHORIZED EYES ONLY','TAP IN. CLOCK IS TICKING.','OPEN. EXECUTE. GO.',
            'CONNECT TO THE GRID','TRACE WILL BE DELETED','TAP IN NOW',
            'ACT BEFORE IT PATCHES','MOVE IN SILENCE','CATCH IT BEFORE IT DROPS',
            'ENTER BEFORE IT CLOSES','MASKED. UNTRACEABLE.','DOWNLOAD BEFORE PURGE',
            'INVISIBLE. EXCLUSIVE.','JOIN OR GET LEFT BEHIND','INVESTIGATE NOW',
            'EXECUTE BEFORE PATCH','COLLECT BEFORE PURGE','TARGET ACQUIRED',
            'CONNECT BEFORE TIMEOUT','TUNE IN NOW','VERIFIED. ENTER.',
            'AUTHORIZED BREACH ONLY','DECRYPT AND ENTER','AFTER HOURS. ELITE ONLY.',
            'SLIP IN. LEAVE NO TRACE.','ONE KEY. ONE CHANCE.','NO TRACE. NO RECORD.',
            'BOOT INTO THE CHANNEL','ONE TIME ACCESS','BREACH WINDOW CLOSING',
            'ENTER WHILE YOU CAN','LATENCY: NOW','DESTINATION FOUND',
            'SESSION EXPIRES IN 60s','LOGOUT WHEN DONE','PROPAGATE. JOIN NOW.',
            'NO NOISE. JUST ENTRY.','RUN THE SCRIPT','KEY BURNS AFTER USE',
        ],
        dividers: [
            '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓','░░░░░░░░░░░░░░░░░░░░','▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒',
            '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬','━━━━━━━━━━━━━━━━━━━━','════════════════════',
            '┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄','▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸','◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂',
            '▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄','╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌','⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇',
            '━┿━┿━┿━┿━┿━┿━┿━┿━','▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄','┼─┼─┼─┼─┼─┼─┼─┼─┼',
            '◇━━━━━━━━━━━━━━━━━━◇','◆──────────────────◆','╠═══════════════════╣',
            '╔════════════════════╗','⊱───────────────────⊰','⬡─⬡─⬡─⬡─⬡─⬡─⬡─⬡',
            '►────────────────────►','◄────────────────────◄','┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃',
            '· ─ · ─ · ─ · ─ · ─','██████████████████████','░█░█░█░█░█░█░█░█░█',
            '╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍','≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋','✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦',
            '◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈','◇ ◇ ◇ ◇ ◇ ◇ ◇ ◇ ◇ ◇','⟫─────────────────⟪',
        ],
        accents: ['⟨','⟩','⟪','⟫','◤','◥','◣','◢','▸','◂','►','◄','⬡','◈','◆','◇','╔','╗','╚','╝','⊱','⊰','⌗','∅','Ø','⟦','⟧','»','«','//','$','#'],
        ornaments: ['◤◤ ─ ◥◥','╔════╗','[ SYS ]','< BREACH >','//LIVE//','$ root@dark','[AUTHORIZED]','>> SIGNAL <<','◆ ─ ◆ ─ ◆'],
    },

    // ─────────────────────────────────────────────────────────────────
    // GIRLY  —  Aesthetic / soft / feminine
    // ─────────────────────────────────────────────────────────────────
    girly: {
        styles: ['lowercase'],
        emojis: ['♡','✦','✧','✿','❀','☾','💎','🦋','🍓','🌙','👑','🩷','💫','🌺','🫧','💌','🌟','🍒','☁','🔮','🌸','🎀','❄','◌','🌹','🍬','✵','🧚','🍡','🌿','🪻','💗','🌷','🌼','🦄','🫐','🍰','🧁','🕊','🫶','🎐','🌈','🐝','🌻','🍋','🌊','🍃'],
        headers: [
            "you're chosen",'your invite is here','not everyone gets this',
            'secret drop','exclusive access only','something special',
            "this one's different",'after hours drop','lowkey elite',
            'main character energy','you didn\'t see this','vip invite only',
            'soft life awaits','invitation only','rare link alert',
            'one link. one chance.','you\'re invited','silent flex',
            'soft but dangerous','this is your sign','new era unlocked',
            'not for everyone','cloud nine vibes','it\'s giving exclusive',
            'lowkey drop','cherry blossom drop','bow drop',
            'pearls only','crescent invite','blossom gate',
            'soft wave drop','moonbeam drop','dainty drop',
            'tiara drop','lavender season','frost drop',
            'halo invite','wisp drop','rose drop',
            'sweet drop','ribbon bow drop','stardust drop',
            'nymph invite','blush drop','mochi drop',
            'wisteria drop','silk drop','gossamer drop',
            'dreamscape drop','pixie invite','fairy dust',
            'petal drop','glow drop','shimmer drop',
            'lace invite','velvet drop','honey drop',
        ],
        footers: [
            'tap before it closes ♡','don\'t keep us waiting','but you do ✿',
            'join before it closes ♡','you qualify 💎','flutter in ♡',
            'taste it 🍓','real ones only ☾','tap in 🔥',
            'enter your era ⚡','just join 🌙','act fast 👑',
            'you belong here 🩷','bloom with us ✿','while it lasts 💫',
            'don\'t miss 🎯','step inside ♡','real ones know ✧',
            'enter if you dare 🫧','don\'t ignore it 💌','step in 🌟',
            'but maybe you 🍒','float in ♡','join the wave 🔮',
            'no noise ♡','petal in 🌸','tie yourself in 🎀',
            'rare find ✧','dream in ♡','walk through ❀',
            'ride in ≈','catch it before it fades 🌙','delicate & rare',
            'crown yourself 👑','bloom in 🪻','chill and enter ❄',
            'angel move ◌','follow the light ✦','petal by petal 🌹',
            'treat yourself 🍬','untie it ♡','catch a star ✵',
            'float in 🧚','soft and exclusive 🩷','sweet & rare 🍡',
            'ground yourself here 🌿','smooth like silk ♡','light as air',
            'dream your way in ♡','light and rare 🍃','sprinkle in ♡',
            'glow up and enter','it\'s soft inside 💗','honey, come in 🍯',
        ],
        dividers: [
            '꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦','· · ─ ─ · · ─ ─ · · ─ ─ · ·',
            '❀ ─ · ─ · ─ · ─ · ─ · ─ ❀','⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇',
            '◇ ◇ ◇ ◇ ◇ ◇ ◇ ◇ ◇ ◇ ◇','·  ·  ·  ·  ·  ·  ·  ·  ·  ·',
            ' ୨─────────────────୧','· · · · · · · · · · · · · ·',
            '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬','━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━',
            '✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦','⟡─────────────────⟡',
            '♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡','⊱ ──────────────── ⊰',
            '˚ · . · ˚ · . · ˚ · . · ˚','◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈',
            '⊱ ─────────────── ⊰','· ─ · ─ · ─ · ─ · ─ · ─ ·',
            '꒰ঌ ─────────────── ໒꒱','━━━━━━━━━━━━━━━━━━━━',
            '✦ · · · · · · · · · · ✦',' ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸',
            '~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~','▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬',
            ' · ·❀· · · ·❀· · · ·❀· ·','˚✧₊⁺ · · · · · · · · ⁺₊✧˚',
            '─ · ─ · ❀ · ─ · ─ · ❀ · ─','≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈ ≈',
            '˚✧ · · · · · · · · · · ✧˚','⸻ · ⸻ · ⸻ · ⸻',
            '✦ · · ◌ · · ✦ · · ◌ · · ✦','❄ · · · · · · · · · · · ❄',
            '◌ · ◌ · ◌ · ◌ · ◌ · ◌','° ˖ · ° ˖ · ° ˖ · ° ˖ · °',
            '· · · · 🌹 · · · · 🌹 · · · ·','˚ · ˚ · ˚ · ˚ · ˚ · ˚ · ˚',
            '── · ── · ── · ── · ──','✵ · · ✵ · · ✵ · · ✵ · · ✵',
            '· ✧ · · · ✧ · · · ✧ · · · ✧','⁺ ˖ ° ⁺ ˖ ° ⁺ ˖ ° ⁺ ˖',
            '⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡','🌸 · 🌸 · 🌸 · 🌸 · 🌸 · 🌸',
        ],
        accents: ['♡','✦','✧','✿','❀','꒰','꒱','◌','✵','˚','☽','⟡','⊱','⊰','✽','◎','°','˗','ˋ','ˊ','˗','~','≈','⸻','∿','‿'],
        ornaments: ['˗ˏˋ ─ ˊˎ˗','꒰ ꒱','✿ · ✿ · ✿','☾ ─ ─ ─ ☽','♡ · · · ♡','◌ ─ ─ ─ ◌','✦ ─ ─ ─ ✦'],
    },

    // ─────────────────────────────────────────────────────────────────
    // GUYS  —  Masculine / high-energy / streetwear
    // ─────────────────────────────────────────────────────────────────
    guys: {
        styles: ['uppercase'],
        emojis: ['💯','🔥','😤','⚡','🗡','💪','🏆','🤫','💰','🎯','🥇','😮‍💨','🦅','💎','🛡','🏋️','🔱','👊','🧠','🌑','🎲','🔒','⚔️','💡','🏴','🚀','🥷','🎖','🏹','🌊','👁','🧱','🌪','🐺','🎱','🏔','⚙️','🔋','🌍','💼','🦁','🎪','🧊','🌓','🔑','⚡','🐯','🏁','🎯','🦊'],
        headers: [
            'NO CAP. THIS IT.','BIG MOVES ONLY','REAL ONES RECOGNIZED',
            'GRIND MODE ON','SAVAGE HOURS','W ENERGY ONLY',
            'BUILT DIFFERENT','NO TALKERS ALLOWED','THE PLUG IS LIVE',
            'LOCKED IN','ELITE CIRCLE','PRESSURE MAKES DIAMONDS',
            'REAL G MOVEMENT','CERTIFIED DROP','HONOR CODE',
            'NO DAYS OFF','KING\'S LINK','EARNED NOT GIVEN',
            'BIG BRAIN MOVE','DARK HORSE DROP','CALCULATED RISK',
            'LOCKED IN SQUAD','BATTLEFIELD OPEN','BIG VISION DROP',
            'BLACK FLAG DROP','LAUNCH SEQUENCE','GHOST MOVE',
            'STRENGTH IN NUMBERS','DECORATED DROP','VOLTAGE DROP',
            'ARROW AIMED','WAVE INCOMING','HEAT CHECK',
            'WATCHING THE MOVE','FOUNDATION DROP','PRECISION DROP',
            'MOMENTUM SHIFT','WOLF PACK LINK','EIGHT BALL DROP',
            'SUMMIT ACCESS','MACHINE RUNNING','FULLY CHARGED DROP',
            'GLOBAL MOVE','BUSINESS ONLY','RED ZONE DROP',
            'ONE SHOT','LION\'S SHARE','MAIN EVENT',
            'ICE COLD DROP','NIGHT SHIFT DROP','KEY HANDED OVER',
            'FINAL VOLTAGE','APEX SIGNAL','WARTIME DROP',
        ],
        footers: [
            'TAP IN OR STAY LOSING 💯','YOU KNOW WHAT IT IS 🔥','LINK UP OR FALL OFF 😤',
            'NO WEAK ENERGY HERE ⚡','CUT THROUGH OR STAY OUT 🗡','L\'s STAY OUTSIDE 💪',
            'NORMAL ONES SWIPE UP 🏆','ACTIONS ONLY 🤫','GET IN OR GET LEFT 💰',
            'NO DISTRACTIONS 🎯','NOT FOR EVERYONE 🥇','PRESSURE APPLIED 😮‍💨',
            'FLAP DIFFERENT 🦅','CERTIFIED OR NOT INVITED 💎','STANDARDS OVER EVERYTHING 🛡',
            'RESULTS REQUIRE ACTION 🏋️','SERFS DON\'T QUALIFY 🔱','WORTH IT OR NOT 👊',
            'READ THE PLAY 🧠','WATCHING FROM THE SHADOWS 🌑','BET ON YOURSELF 🎲',
            'SOLID OR DON\'T APPLY 🔒','COWARDS SKIP THIS ⚔️','SMALL MINDS WON\'T GET IT 💡',
            'WE DON\'T EXPLAIN MOVES 🏴','IGNITE OR GET LEFT 🚀','SILENT AND DEADLY 🥷',
            'LINK OR MISS OUT 💪','EARNED YOUR SPOT 🎖','HIT THE TARGET 🏹',
            'RIDE OR DROWN 🌊','DON\'T MISS THE PLAY 👁','BUILD ON THIS 🧱',
            'CHANGE THE TIDE 🌪','HOWL OR STAY SOLO 🐺','BEHIND THE EIGHT BALL 🎱',
            'NOT FOR THOSE WHO QUIT 🏔','COGS TURNING ⚙️','MAX ENERGY ONLY 🔋',
            'NO LOCAL MINDSET 🌍','LEAVE EMOTIONS OUTSIDE 💼','DANGER ZONE ENTRY 🔴',
            'MAKE IT COUNT 🎯','KING ENERGY ONLY 🦁','CENTER STAGE DROP 🎪',
            'COOL HEADS ONLY 🧊','WHILE THEY SLEEP 🌓','LAST DROP. LAST CHANCE. ⚡',
        ],
        dividers: [
            '━━━━━━━━━━━━━━━━━━━━','▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬','◆─────────────────◆',
            '▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸','◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂','═══════════════════',
            '┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄','◇━━━━━━━━━━━━━━━━━◇','· ─ · ─ · ─ · ─ · ─',
            '╔═══════════════════╗','◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈ ◈','⟫─────────────────⟪',
            '┼─┼─┼─┼─┼─┼─┼─┼─┼','▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄▀▄','⊱──────────────────⊰',
            '┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅┅','╠══════════════════╣','▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
            '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀','◤◤◤◤◤◤◤◤◤◤◤◤◤◤◤◤◤','◥◥◥◥◥◥◥◥◥◥◥◥◥◥◥◥◥',
            '┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃','━┿━┿━┿━┿━┿━┿━┿━┿━','✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦',
            '░░░░░░░░░░░░░░░░░░░','⟫⟫⟫⟫⟫⟫⟫⟫⟫⟫⟫⟫⟫⟫⟫','⟪⟪⟪⟪⟪⟪⟪⟪⟪⟪⟪⟪⟪⟪⟪',
            '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌','▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬','─ ─ ─ ─ ─ ─ ─ ─ ─ ─',
            '▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌','► ► ► ► ► ► ► ► ► ►','◄ ◄ ◄ ◄ ◄ ◄ ◄ ◄ ◄ ◄',
            '≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋≋','⬡─⬡─⬡─⬡─⬡─⬡─⬡─⬡','┼┼┼┼┼┼┼┼┼┼┼┼┼┼┼┼┼┼┼',
            '╔─────────────────╗','╚─────────────────╝','⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡',
        ],
        accents: ['💯','⚡','🔱','🗡','⚔️','🏴','🏹','🌑','🦅','🔒','💎','🎯','🏆','👊','⚙️','🔥','💪','🌪','🐺'],
        ornaments: ['◆──◆','[ ELITE ]','>> GO <<','▸ ▸ ▸','━━━ ⚔️ ━━━','[ LOCKED ]','//GRIND//','★ APEX ★'],
    },

    // ─────────────────────────────────────────────────────────────────
    // GOTHIC  —  Dark / ornate / cathedral
    // ─────────────────────────────────────────────────────────────────
    gothic: {
        styles: ['lowercase'],
        emojis: ['✝','☽','⛧','🕷','🦇','💀','☠','🥀','🕸','🌑','🕯','⚰','🗡','🔮','🖤','🩸','👁','🐍','🦂','🌙','⚔','🫀','🌒','🌓','🌔','⚗','🧿','🔯'],
        headers: [
            'the crypt awaits','darkness descends','a gothic summons',
            'shadows call','the veil parts','midnight congregation',
            'dwell in darkness','chosen by the night','shadows whisper your name',
            'a raven arrives','the black gate opens','shrouded in night',
            'beyond the mist','the curse is lifted','crypts and covens',
            'darkness speaks','fallen angel drop','from the abyss',
            'below the surface','night eternal','unholy gathering',
            'necromancer\'s call','veiled summons','cathedral of shadows',
            'the damned assemble','dark covenant','macabre invitation',
            'sinister circle','gothic archive','obsidian portal',
            'the mourning hour','beneath the tombstone','shadow covenant',
            'cursed invitation','the witch\'s circle','eternal midnight',
            'black rose drop','death\'s door opens','from the other side',
            'gothic revival','skull and crown drop','the haunting begins',
        ],
        footers: [
            'enter the dark','step into shadow','the night claims you',
            'dwell or dissolve','consume the darkness','join the congregation',
            'follow the raven','enter the crypt','shadows guide you',
            'embrace the void','the abyss awaits','descend willingly',
            'cursed and chosen','walk the night','sealed in darkness',
            'the altar is ready','blood and shadow','eternal night entry',
            'the damned welcome you','vanish into darkness','forever fallen',
            'gothic souls only','the grave is open','darkness is home',
            'lost souls enter here','bones and roses await','the coven calls you',
        ],
        dividers: [
            '✝ ─ ✝ ─ ✝ ─ ✝ ─ ✝ ─ ✝ ─ ✝','⛧ · · · · · · · · · · · ⛧',
            '☽ · ☽ · ☽ · ☽ · ☽ · ☽ · ☽','━━━━━━━━━━━━━━━━━━━━',
            '════════════════════','▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
            '░░░░░░░░░░░░░░░░░░░','▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒',
            '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓','─ · ─ · ─ · ─ · ─ · ─ · ─',
            '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌','┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄',
            '💀 · · · · · · · · · · 💀','🕯 ─ 🕯 ─ 🕯 ─ 🕯 ─ 🕯',
            '🥀 · · · · · · · · · · 🥀','☠ · ☠ · ☠ · ☠ · ☠ · ☠',
            '🦇 · · · · · · · · · · 🦇','◆─────────────────◆',
            '◇ · · · · · · · · · · · ◇','╔═══════════════════╗',
            '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄','▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
            '· ─ · ─ · ─ · ─ · ─ · ─ ·','👁 · · · · · · · · · · · 👁',
            '🕷 ─ ─ 🕸 ─ ─ 🕷 ─ ─ 🕸 ─ ─ 🕷','⚰ · · · · · · · · · · · ⚰',
        ],
        accents: ['✝','⛧','☽','☠','💀','🥀','🕯','🦇','🕷','⚰','🗡','🔮','🖤','🩸','👁','🐍','⚔','🌑','🌙'],
        ornaments: ['✝ ─ ☽ ─ ✝','⛧ ─ ─ ─ ⛧','💀 ─ 💀','[ CRYPT ]','~ ~ DARK ~ ~','🕯 · · · 🕯','☠ ─ ─ ─ ☠'],
    },

    // ─────────────────────────────────────────────────────────────────
    // KAWAII  —  UwU / cute / bubbly / pastel
    // ─────────────────────────────────────────────────────────────────
    kawaii: {
        styles: ['lowercase'],
        emojis: ['✨','🌸','💕','🍡','🍓','🎀','🌈','💫','🌟','🍰','🧁','🐱','🐰','🐭','🦄','🌷','🌺','💖','💝','💘','🎵','🎶','♪','✿','🎠','🍭','🍬','🍩','🌺','🌸','🌼','💟','💞','❣','🫧','🧸','🐣','🐥','🐾'],
        headers: [
            'uwu drop 🌸','nyaa!! you\'re invited','OMG omg omg!!',
            'kawaii drop time ✨','hiii bestiee!!','omg look look look',
            'psst!! it\'s time uwu','squeeeee!! a drop!','yay yay yay!! come in!!',
            'cutest drop ever!!','heyyy cutiepie ♡','eep!! you\'re chosen!!',
            'omg omg you qualified!!','✨ sparkle drop ✨','bestiee i found it',
            '*jumps* *jumps* join!!!','*waves paws* hiiiii','a lil invite for u',
            'soft mode activated uwu','*blushes* hi... join us?',
            'teehee!! here\'s ur drop','(◕‿◕) drop time!!',
            'omg the cutest link ever','aaaaaaa you\'re invited!!!',
            '*happy squeaks* join us!','nya nya nya!! come!!',
            '(≧◡≦) omg finally!!','*wiggles* you made it!!',
            'giggles!! you\'re in!!','bestiee drop time hehe!!',
            'floof floof join us!!','boing boing tap here!!',
            'UwU a fresh drop!!','hewwo!! come insideeee',
        ],
        footers: [
            'tap tap tap!! ✨','come come come!! 🌸','hurry hurry ♡',
            'uwu join us pleaseeee','*paw gestures* this way!','pls pls pls tap!! 💕',
            'don\'t miss it nyaaa!!','enter!! now!! *vibrates*','yay come play with us!! 🎀',
            '*sparkles* tap in!! ✨','it\'s so cute inside!! 🌈','we\'re waiting uwu ♡',
            'bestieeee don\'t leave!!','*wiggles* tap it!! 💫','omg yes do it!! 🍡',
            'squeeeee hurry!!','tap or i cry 🥺','*bounces* join!!',
            'please please please!! 💕','bestiee we need u!!',
            'yayyyy do it NOW!! ✨','*kicks feet* come in!!',
        ],
        dividers: [
            '✨ · · ✨ · · ✨ · · ✨ · · ✨','🌸 · 🌸 · 🌸 · 🌸 · 🌸 · 🌸',
            '💕 · · · · · · · · · · · 💕','♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡',
            '✿ · · · · · · · · · · · ✿','❀ ─ · ─ · ─ · ─ · ─ ❀',
            '˚ · . · ˚ · . · ˚ · . · ˚','° ˖ · ° ˖ · ° ˖ · ° ˖ · °',
            '· · · · · · · · · · · · · ·','✦ · · ✦ · · ✦ · · ✦ · · ✦',
            '◌ · ◌ · ◌ · ◌ · ◌ · ◌ · ◌','🎀 · · · · · · · · · · 🎀',
            '🍡 · · · · · · · · · · 🍡','🌈 · · · · · · · · · · 🌈',
            '💫 · · · · · · · · · · 💫','🌟 · · · · · · · · · · 🌟',
            '🍰 · · · · · · · · · · 🍰','🐱 · · · · · · · · · · 🐱',
            '🦄 · · · · · · · · · · 🦄','🌷 · · · · · · · · · · 🌷',
            '💖 · · · · · · · · · · 💖','🧸 · · · · · · · · · · 🧸',
            '🍭 · ─ 🍭 · ─ 🍭 · ─ 🍭','🎵 · · · 🎶 · · · 🎵 · · · 🎶',
            '～ ～ ～ ～ ～ ～ ～ ～','꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦',
        ],
        accents: ['✨','🌸','💕','♡','✿','❀','˚','°','·','✦','✧','◌','♪','✵','UwU','OwO','nyaa','uwu','~','≈','(◕','◕)'],
        ornaments: ['(｡♥‿♥｡)','UwU ─ UwU','✨ ~ ✨','(◕‿◕)','OwO!!','🌸 nyaa 🌸','* sparkle *'],
    },

    // ─────────────────────────────────────────────────────────────────
    // YAMI  —  Yami-kawaii / pastel-dark / soft & broken
    // ─────────────────────────────────────────────────────────────────
    yami: {
        styles: ['lowercase'],
        emojis: ['🖤','🩸','💊','🩹','🥀','🌑','☠','💀','🔪','⚰','🕯','🗡','♠','♣','♦','♥','🌙','🌸','💉','🩶','🩵','🫀','🩺','🖤','🌷','💔','🌿','🧪','⚗','🔫','🎲'],
        headers: [
            'dark drop 🖤','not everyone survives','yami hours',
            'soft & broken','dark petal drop','beneath the surface',
            'ache & enter','wounds & wonders','tender darkness',
            'soft core drop','beneath it all','quiet & heavy',
            'still and silent drop','thorns and softness','delicate ruin',
            'fragile signals','mended & dark','yami aesthetic drop',
            'bittersweet entry','dark bloom','bruised petal drop',
            'soft but hurting','heavy & chosen','beautiful damage',
            'scars & softness','quiet storm drop','tearstained invite',
            'tender ruins','gently broken','soft void drop',
            'pastel & pain','darkness & lace','numb & invited',
        ],
        footers: [
            'enter the hurt ♥','walk the edge 🖤','soft steps in',
            'tender entry','feel it, enter it','open the wound, find us',
            'enter softly 🌑','the dark side is soft too','in the quiet, join us',
            'where it hurts, we are','tender hearts only','soft & dark inside',
            'bruised but beautiful entry','delicate & damaged drop','find peace in the dark',
            'broken but invited','quietly join us','the void is soft',
            'enter gently 🥀','thorns won\'t stop you','healing starts inside',
            'it\'s okay, come in','soft & safe inside','we understand, enter',
        ],
        dividers: [
            '♠ · ♣ · ♦ · ♥ · ♠ · ♣ · ♦ · ♥','🖤 · · · · · · · · · · · 🖤',
            '🩸 · · · · · · · · · · · 🩸','🥀 · · · · · · · · · · · 🥀',
            '🌑 · · · · · · · · · · · 🌑','─ · ─ · ─ · ─ · ─ · ─ · ─',
            '━━━━━━━━━━━━━━━━━━━','════════════════════',
            '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬','░░░░░░░░░░░░░░░░░░░',
            '▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒','♠ ♠ ♠ ♠ ♠ ♠ ♠ ♠ ♠ ♠ ♠',
            '💀 · · · · · · · · · 💀','🕯 ─ 🕯 ─ 🕯 ─ 🕯 ─ 🕯',
            '· · · · · · · · · · · · · ·','🌸 · · · · · · · · · · 🌸',
            '💊 · · 💊 · · 💊 · · 💊','🩹 · ─ · 🩹 · ─ · 🩹 · ─ · 🩹',
            '💔 · · · · · · · · · · · 💔','꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦꒷꒦',
            '∿ ∿ ∿ ∿ ∿ ∿ ∿ ∿ ∿ ∿ ∿','‿ ‿ ‿ ‿ ‿ ‿ ‿ ‿ ‿ ‿ ‿',
        ],
        accents: ['🖤','🩸','♠','♣','♦','♥','🥀','🌑','☠','💀','🔪','🕯','🗡','💊','💔','∿','‿','~'],
        ornaments: ['♠ ─ ♠','🖤 ─ 🖤','─ yami ─','🥀 · 🥀','[ soft ]','~ dark ~','♥ · ♦ · ♥'],
    },

    // ─────────────────────────────────────────────────────────────────
    // VAMPIRE  —  Blood / nocturnal / gothic-romantic
    // ─────────────────────────────────────────────────────────────────
    vampire: {
        styles: ['lowercase'],
        emojis: ['🦇','🌙','🩸','🥀','🕯','👁','🗡','⚰','☽','🌑','🌒','💀','☠','🌹','🐍','🕷','🕸','🌃','🌌','🫀','🔮','🖤','⛧','✝','🌓'],
        headers: [
            'the blood moon rises','a vampire\'s invitation','crimson drop',
            'night of the immortals','feast of shadows','the castle awaits',
            'eternal thirst drop','from the coffin depths','moonrise gathering',
            'sanguine summons','the coven calls','bloodline drop',
            'undead exclusive','red moon rising','gothic blood drop',
            'nocturnal gathering','dusk till dawn drop','the lord summons',
            'crimson tide','fangs & invitation','the eternal invite',
            'immortal drop','night lord\'s circle','blood covenant',
            'dracula\'s choice','the undead circle','night of blood',
            'count\'s invitation','crimson seal','eternal midnight drop',
            'blood moon signal','the thirst begins','awakened in darkness',
        ],
        footers: [
            'enter before sunrise','the night is yours','drink deep and join',
            'fangs welcome you','eternal entry','blood and shadow await',
            'rise and join','the coven welcomes you','immortal now',
            'eternal darkness entry','join before dawn','the castle is open',
            'undead inside','blood-sealed entry','night eternal, join us',
            'fangs out, enter','bite and enter','crimson path inside',
            'immortal awaits you','forever in the dark','blood calls to blood',
        ],
        dividers: [
            '🦇 · · · · · · · · · · 🦇','🩸 · · · · · · · · · · 🩸',
            '🥀 · · · · · · · · · · 🥀','🌙 · 🌙 · 🌙 · 🌙 · 🌙 · 🌙',
            '☽ · ☽ · ☽ · ☽ · ☽ · ☽ · ☽','─ · ─ · ─ · ─ · ─ · ─ · ─',
            '━━━━━━━━━━━━━━━━━━━','════════════════════',
            '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬','░░░░░░░░░░░░░░░░░░░',
            '🕯 ─ 🕯 ─ 🕯 ─ 🕯 ─ 🕯','💀 · · · · · · · · · 💀',
            '🌹 · · · · · · · · · 🌹','🌑 · · · · · · · · · 🌑',
            '· · · · · · · · · · · · · ·','⛧ · · · · · · · · · · · ⛧',
            '✝ ─ ✝ ─ ✝ ─ ✝ ─ ✝ ─ ✝','🕷 ─ ─ 🕸 ─ ─ 🕷 ─ ─ 🕸 ─ ─ 🕷',
            '◆─────────────────◆','▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒',
            '║═══════════════════║','🫀 · · · · · · · · · · · 🫀',
        ],
        accents: ['🦇','🩸','🥀','🌙','☽','🕯','💀','🗡','⚰','👁','🐍','🕷','🌹','🫀','✝','⛧','☠','🔮'],
        ornaments: ['🦇 ─ 🦇','☽ · ─ · ☾','─ COVEN ─','🩸 · 🩸','🌙 ─ 🌙','✝ ─ ⛧ ─ ✝','[ IMMORTAL ]'],
    },

    // ─────────────────────────────────────────────────────────────────
    // ANGEL  —  Heavenly / celestial / pure light
    // ─────────────────────────────────────────────────────────────────
    angel: {
        styles: ['lowercase'],
        emojis: ['✦','☆','◌','♡','🕊','👼','✨','🌤','☀','🌟','💫','⭐','🌈','☁','🌸','💐','🌺','🤍','🫶','✝','🙏','🕯','🌙','💎','🔮','🪷','🌿','🌊','🦢','🌻','🌼','🍃','🌱'],
        headers: [
            'heaven sent','you\'ve been chosen from above','angelic drop',
            'a blessing arrives','divine invitation','from the clouds',
            'celestial summons','holy drop','a gift from above',
            'the gates open','angel circle invite','divine light drop',
            'sacred summons','blessed drop','heaven\'s gate opens',
            'gracious invitation','light descends','wings carry this',
            'from the highest','radiant drop','celestial chosen',
            'pure invitation','holy grace drop','divine messenger',
            'a whisper from above','the seraph calls','golden hour drop',
            'light of grace','blessed signal','luminous drop',
            'from the divine','aurora invitation','the halo drops',
            'wings of invitation','sacred circle drop','chosen by light',
        ],
        footers: [
            'ascend and join ✦','enter the light ♡','heaven awaits inside',
            'wings guide you in','blessed entry','grace and enter',
            'pure hearts only','the divine calls you','light the way in',
            'follow the glow ✨','sacred entry ✦','chosen ones enter',
            'step into the light','your blessing awaits','wings carry you forward',
            'float up and in','holy entry','light fills this space',
            'rise and enter','the angels welcome you','guided by grace',
            'enter in peace ✦','radiance awaits you','the divine sees you',
        ],
        dividers: [
            '✦ · · · · · · · · · · · ✦','☆ · ☆ · ☆ · ☆ · ☆ · ☆ · ☆',
            '◌ · ◌ · ◌ · ◌ · ◌ · ◌ · ◌','♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡ ♡',
            '· · · · · · · · · · · · · ·','˚ · . · ˚ · . · ˚ · . · ˚',
            '° ˖ · ° ˖ · ° ˖ · ° ˖ · °','✨ · · · · · · · · · · ✨',
            '⊹ · · ⊹ · · ⊹ · · ⊹ · · ⊹','─ · ─ · ─ · ─ · ─ · ─ · ─',
            '━━━━━━━━━━━━━━━━━━━','════════════════════',
            '🕊 · · · · · · · · · · 🕊','💫 · · · · · · · · · · 💫',
            '🌟 · · · · · · · · · · 🌟','⭐ · · ⭐ · · ⭐ · · ⭐ · · ⭐',
            '🌈 · · · · · · · · · · 🌈','✝ · · · · · · · · · · · ✝',
            '🤍 · · · · · · · · · · 🤍','🌸 · 🌸 · 🌸 · 🌸 · 🌸 · 🌸',
            '🦢 · · · · · · · · · · 🦢','💎 · · 💎 · · 💎 · · 💎',
            '⊱ ──────────────── ⊰','꒰ঌ ─────────────── ໒꒱',
        ],
        accents: ['✦','☆','◌','♡','·','˚','°','✨','⊹','🕊','💫','🌟','🌸','💐','🤍','🫶','✝','🌺','🦢','💎','🪷'],
        ornaments: ['✦ ─ ✦','☆ · ☆ · ☆','[ DIVINE ]','♡ ─ ♡','🕊 ─ 🕊','⊹ ─ ⊹','* holy *'],
    },

    // ─────────────────────────────────────────────────────────────────
    // WEBCORE  —  Y2K / retro-internet / dial-up nostalgia
    // ─────────────────────────────────────────────────────────────────
    webcore: {
        styles: ['mixed'],
        emojis: ['⊹','✦','⌁','🖥','📺','📟','📱','💾','💿','📀','🖱','🕹','🎮','📡','📻','📠','🔊','💡','💻','🌐','📧','📨','📩','💬','🔔','⚡','🌐'],
        headers: [
            '< welcome to the net >','[Y2K DROP INCOMING]','// system online //',
            'www.you.invited.here','loading... please wait','buffering ur invite',
            '>>connecting to server','dial-up drop 📟','404: exclusivity not found',
            'you\'ve got an invite!','ping received','internet explorer drop',
            'AOL instant message','netscape navigator drop','under construction 🚧',
            'click here to enter','you have (1) new invite','your connection is ready',
            'welcome to the web ⊹','access granted. loading.','[SYSTEM MESSAGE]',
            '>> open your browser','[ DOWNLOADING INVITE ]','establishing connection...',
            'ICQ: message received','<blink> tap here </blink>','MSN online: invite',
            'www dot join dot now','site: invite.drop.net','powered by invite 2000',
            'your modem is ringing','file://invite/open.me','error 200: you\'re in',
            '[ NEW MESSAGE: 1 ]','geocities drop','xanga invite page',
        ],
        footers: [
            'click to connect ⊹','enter the web','tap and load up',
            'loading... 99% complete','connect now, lag later','>> join the network',
            'buffering ended. enter.','your session begins','internet explorer awaits',
            'online and waiting','connection established','loading complete. enter.',
            '>> proceed to site','you\'ve been connected','welcome to the internet',
            'site fully loaded','press enter to begin','buffering... done.',
            'connected at 56k','your download is ready','enter the homepage',
            'page has loaded','tap and dial in','join the network now',
        ],
        dividers: [
            '⊹ · · ⊹ · · ⊹ · · ⊹ · · ⊹','✦ ─ ✦ ─ ✦ ─ ✦ ─ ✦ ─ ✦ ─ ✦',
            '─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─','━━━━━━━━━━━━━━━━━━━━',
            '════════════════════','░░░░░░░░░░░░░░░░░░░░',
            '▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒','▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
            '· · · · · · · · · · · · · ·','~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
            '// // // // // // // //','== == == == == == == ==',
            '.. .. .. .. .. .. .. ..','-- -- -- -- -- -- -- --',
            '[[ ]]─[[ ]]─[[ ]]─[[ ]]','{{ }}─{{ }}─{{ }}─{{ }}',
            '<< >>─<< >>─<< >>─<< >>','⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁⌁',
            '💾 ─ 💾 ─ 💾 ─ 💾 ─ 💾','📡 · · · · · · · · · · 📡',
            '🌐 ─ 🌐 ─ 🌐 ─ 🌐 ─ 🌐','⊹ ─ ⊹ ─ ⊹ ─ ⊹ ─ ⊹ ─ ⊹',
            '◇ · · · · · · · · · · · ◇','◆─────────────────◆',
        ],
        accents: ['⊹','✦','⌁','<','>','[',']','(',')','/','*','=','.','~','>>','<<','::','{}','()','//','--','=='],
        ornaments: ['< INVITE >','[Y2K]','// web //','>> click <<','[ online ]','www ─ www','[ sys ]'],
    },

    // ─────────────────────────────────────────────────────────────────
    // DARK  —  Minimalist / stark / editorial blackout
    // ─────────────────────────────────────────────────────────────────
    dark: {
        styles: ['uppercase'],
        emojis: ['🖤','⬛','◼','◾','▪','◆','◇','▬','▸','◂','·','─','━','█','▓','░','▒','⚫','🔲','🔳'],
        headers: [
            'DROP','SIGNAL','ACCESS','ENTRY','LINK',
            'CHANNEL','INVITE','GATE','TRANSMISSION','PAYLOAD',
            'NODE','VECTOR','MOTION','CURRENT','FLOW',
            'SHIFT','ANCHOR','PULL','REACH','KEY',
            'LOCK','OPEN','SILENT DROP','QUIET ENTRY','LONE SIGNAL',
            'AFTER DARK','NIGHT MOVE','DARK DROP','VOID ENTRY','BLACK SIGNAL',
            'NEGATIVE SPACE','SHADOW DROP','MINIMAL DROP','CLEAN CUT','STARK ENTRY',
            'DIRECT ACCESS','PURE SIGNAL','UNFILTERED','RAW ENTRY','STRIPPED DOWN',
            'CORE DROP','ESSENCE','FORM','EDGE','POINT',
        ],
        footers: [
            'ENTER','TAP IN','NOW','GO','MOVE',
            'JOIN','CONNECT','PROCEED','ACT','STEP IN',
            'ENGAGE','INITIATE','DESCEND','FOLLOW','OPEN',
            'CONFIRM','PROCEED','ENTER NOW','ACTIVATE','DONE',
            'IN','ACCESS','ACKNOWLEDGED','RECEIVED','CONFIRMED',
        ],
        dividers: [
            '────────────────────','━━━━━━━━━━━━━━━━━━━━',
            '════════════════════','▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬',
            '░░░░░░░░░░░░░░░░░░░░','▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒',
            '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓','████████████████████',
            '· · · · · · · · · · · · · ·','─ ─ ─ ─ ─ ─ ─ ─ ─ ─',
            '━ ━ ━ ━ ━ ━ ━ ━ ━ ━','▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸ ▸',
            '◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂ ◂','┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄',
            '╌ ╌ ╌ ╌ ╌ ╌ ╌ ╌ ╌ ╌','◆ · · · · · · · · ◆',
            '◇ · · · · · · · · ◇','▬ · ▬ · ▬ · ▬ · ▬',
        ],
        accents: ['🖤','⬛','◼','◾','▪','◆','◇','▸','◂','·','─','━','█','▓','░','■','□'],
        ornaments: ['◆ ─ ◆','▸ ─ ◂','[ ]','─ · ─','■ ─ ■','◼ ◼ ◼','· · ·'],
    },

    // ─────────────────────────────────────────────────────────────────
    // PRESTIGE  —  Luxury / elevated / premium brand
    // ─────────────────────────────────────────────────────────────────
    prestige: {
        styles: ['lowercase'],
        emojis: ['⬡','◈','✦','◆','▪','🖤','💎','👑','🏆','🥇','⭐','🌟','✨','🪙','💳','🔐','💠','🔷','🔹','◇','🏅','🎖','🏵','🔑','🪄'],
        headers: [
            'prestige drop','elite access','distinguished invite',
            'by invitation only','premier circle','exclusive tier',
            'gold tier invite','first class entry','top tier signal',
            'the prestige drop','inner circle access','hallmark invite',
            'benchmark entry','vanguard drop','class drop',
            'signature invite','premium entry','apex invite',
            'criterion drop','echelon access','guild invite',
            'summit access','the prestige','honour tier',
            'luxury invite','no noise. prestige.','select access',
            'distinguished entry','privilege drop','curator\'s invite',
            'rare access granted','flagship drop','collector\'s invite',
            'the gold standard','platinum invite','the chosen tier',
        ],
        footers: [
            'no noise. just entry.','prestige granted','elite confirmed',
            'access approved','distinction awarded','honour accepted',
            'privilege unlocked','class confirmed','standard exceeded',
            'benchmark met','tier unlocked','circle complete',
            'entry earned','vanguard confirmed','summit reached',
            'prestige recognized','gold accepted','honour given',
            'the bar is raised','excellence inside','worth confirmed',
            'your distinction awaits','set apart. enter.','curated entry',
        ],
        dividers: [
            '⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡ ─ ⬡','◈ · · · · · · · · · · · ◈',
            '◆─────────────────◆','◇ · · · · · · · · · · · ◇',
            '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬','━━━━━━━━━━━━━━━━━━━━',
            '════════════════════','─────────────────────',
            '· · · · · · · · · · · · · ·','▸ · · · · · · · · · · ◂',
            '▪ · ▪ · ▪ · ▪ · ▪ · ▪','■ ─ ■ ─ ■ ─ ■ ─ ■ ─ ■',
            '□ · □ · □ · □ · □ · □','◈ ─ ◈ ─ ◈ ─ ◈ ─ ◈ ─ ◈',
            '⬡ · ⬡ · ⬡ · ⬡ · ⬡ · ⬡','💎 · · · · · · · · · · 💎',
            '👑 ─ 👑 ─ 👑 ─ 👑 ─ 👑','⭐ · · ⭐ · · ⭐ · · ⭐ · · ⭐',
            '✦ · · · · · · · · · · · ✦','✦ ─ ✦ ─ ✦ ─ ✦ ─ ✦ ─ ✦',
            '◆ · · ◆ · · ◆ · · ◆ · · ◆','◇━━━━━━━━━━━━━━━━━━◇',
        ],
        accents: ['⬡','◈','◆','◇','▪','■','□','▸','◂','·','━','═','─','🖤','💎','👑','✦','◎','▬'],
        ornaments: ['⬡ ─ ⬡','◈ · ◈','[ PRESTIGE ]','✦ ─ ✦','◆ ─ ◆','▪ ─ ▪','— ELITE —'],
    },

};

// Freeze all asset arrays for safe access from any context
for (const theme of Object.values(ASSETS)) {
    for (const [k, v] of Object.entries(theme)) {
        if (Array.isArray(v)) Object.freeze(v);
    }
    Object.freeze(theme);
}
Object.freeze(ASSETS);

// ══════════════════════════════════════════════════════════════════════
// §4  THEME CONFIGURATION
// ══════════════════════════════════════════════════════════════════════

const VALID_THEMES = Object.freeze([
    'cyber','girly','guys','gothic','kawaii','yami',
    'vampire','angel','webcore','dark','prestige',
]);

/** Apply a theme's preferred text casing. */
function _applyStyle(str, style) {
    if (style === 'uppercase') return str.toUpperCase();
    if (style === 'lowercase') return str.toLowerCase();
    return str; // 'mixed' = preserve as-is
}

// ══════════════════════════════════════════════════════════════════════
// §5  GENERATOR ENGINE
// ══════════════════════════════════════════════════════════════════════

/**
 * Core template generator.
 * Zero I/O. Zero allocation beyond the output string. Sub-1 ms.
 *
 * @param {number} seed        - Deterministic PRNG seed
 * @param {string} theme       - Theme key (must exist in ASSETS)
 * @param {string} inviteLink  - WhatsApp invite link
 * @returns {string}           - Complete formatted message
 */
function _generate(seed, theme, inviteLink) {
    const A   = ASSETS[theme] || ASSETS.cyber;
    const rng = _prng(seed >>> 0 || 1);

    // ── style ─────────────────────────────────────────────────────────
    const sty      = _pick(rng, A.styles);

    // ── select assets ─────────────────────────────────────────────────
    const rawHeader  = _pick(rng, A.headers);
    const rawFooter  = _pick(rng, A.footers);
    const emoji1     = _pick(rng, A.emojis);
    const emoji2     = _pick(rng, A.emojis);
    const accent     = _pick(rng, A.accents);
    const divTop     = _pick(rng, A.dividers);
    // 35% chance: different bottom divider (asymmetry)
    const divBot     = rng() < 0.35 ? _pick(rng, A.dividers) : divTop;

    // ── apply casing ──────────────────────────────────────────────────
    const header     = _applyStyle(rawHeader, sty);
    const footer     = _applyStyle(rawFooter, sty);

    // ── decorate header (60% get emoji wrap) ─────────────────────────
    const headerDeco = rng() < 0.60
        ? `${emoji1} ${header} ${emoji2}`
        : header;

    // ── decorate footer (55% get accent prefix) ───────────────────────
    const footerDeco = rng() < 0.55
        ? `${accent} ${footer}`
        : footer;

    // ── ornament line (built from ornaments array or improvised) ──────
    const hasOrnaments = Array.isArray(A.ornaments) && A.ornaments.length > 0;
    const ornament = hasOrnaments
        ? _pick(rng, A.ornaments)
        : `${emoji1} ${accent} ${emoji2}`;

    // ── layout selection (7 layouts for maximum variety) ──────────────
    const layout = (rng() * 7) | 0;
    const link   = String(inviteLink || '');

    switch (layout) {

        case 0: // Minimal  —  3 sections
            return [headerDeco, divTop, link, divBot, footerDeco].join('\n');

        case 1: // Ornament top  —  ornament / header / divider / link / divider / footer
            return [ornament, headerDeco, divTop, link, divBot, footerDeco].join('\n');

        case 2: // Double-frame  —  ornament / divider / link / divider / ornament+footer
            return [ornament, divTop, link, divBot, `${ornament}\n${footerDeco}`].join('\n');

        case 3: // Cathedral  —  header / div / ornament / link / ornament / div / footer
            return [headerDeco, divTop, ornament, link, ornament, divBot, footerDeco].join('\n');

        case 4: // Bracketed  —  header / [accent link accent] / footer
            return [headerDeco, divTop, `${accent} ${link} ${accent}`, divBot, footerDeco].join('\n');

        case 5: // Stacked emoji  —  emoji / header / div / link / div / footer / emoji
            return [emoji1, headerDeco, divTop, link, divBot, footerDeco, emoji2].join('\n');

        case 6: // Wide ornament  —  ornament / div / link / div / footer
        default:
            return [ornament, divTop, link, divBot, footerDeco].join('\n');
    }
}

// ══════════════════════════════════════════════════════════════════════
// §6  PER-GROUP SEED STORE
// ══════════════════════════════════════════════════════════════════════

/**
 * Read the persisted seed for a group+theme.
 * On first access: generates a stable deterministic seed from the key itself,
 * stores it, and returns it — so the same group always gets the same "random"
 * template even without an explicit assignment.
 */
function _getSeed(groupJid, theme) {
    const t = String(theme || _activeTheme).toLowerCase();
    const k = `${String(groupJid || '')}::${t}`;
    const v = _store[k];

    // Migrate legacy integer index  →  treat as seed directly
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && typeof v.seed === 'number') return v.seed;

    // First visit: pick a truly random seed so every group gets a unique design
    const seed = _newSeed();
    _store[k]  = { seed };
    _saveStore();
    return seed;
}

/** Persist a seed for a group+theme. */
function _setSeed(groupJid, theme, seed) {
    const t   = String(theme || _activeTheme).toLowerCase();
    const k   = `${String(groupJid || '')}::${t}`;
    _store[k] = { seed: (seed >>> 0) || 1 };
    _saveStore();
}

// ══════════════════════════════════════════════════════════════════════
// §7  PUBLIC API
// ══════════════════════════════════════════════════════════════════════

/** Return the currently active theme name. */
function getActiveTheme() {
    return _activeTheme;
}

/**
 * Set the active theme globally (persisted to disk).
 * @param {string} theme
 * @returns {string} The new active theme
 * @throws {Error} If the theme is unknown
 */
function setActiveTheme(theme) {
    const t = String(theme || '').toLowerCase().trim();
    if (!VALID_THEMES.includes(t))
        throw new Error(`Unknown theme "${t}". Valid: ${VALID_THEMES.join(', ')}`);
    _activeTheme = t;
    _saveTheme();
    return _activeTheme;
}

/**
 * Render a godcast message for a group.
 *
 * @param {object}  opts
 * @param {string}  [opts.groupJid]      - Group JID (used to look up the persisted seed)
 * @param {string}  [opts.inviteLink]    - The WhatsApp group invite link
 * @param {number}  [opts.templateIndex] - If supplied, used directly as seed (legacy compat)
 * @param {string}  [opts.theme]         - Override the active theme for this render
 * @returns {string}
 */
function renderGodcastTemplate({ groupJid, inviteLink, templateIndex, theme } = {}) {
    try {
        const t    = String(theme || _activeTheme).toLowerCase();
        const seed = templateIndex !== undefined
            ? (Math.max(1, Number(templateIndex) >>> 0) || 1)
            : _getSeed(groupJid, t);
        return _generate(seed, t, inviteLink);
    } catch {
        // Hard fallback — never throw to caller
        return `🔐 GODCAST DROP\n━━━━━━━━━━━━━━━━━━━━\n${String(inviteLink || '')}\n━━━━━━━━━━━━━━━━━━━━\nTAP IN NOW`;
    }
}

/**
 * Assign a specific template seed to a group.
 * Legacy callers that pass a template index will have that integer treated as the seed.
 *
 * @param {string} groupJid
 * @param {number} idx   - Seed value (any positive integer, or 0 → auto-generate)
 * @param {string} [theme]
 */
function assignGroupTemplate(groupJid, idx, theme) {
    const t    = String(theme || _activeTheme).toLowerCase();
    const seed = idx !== undefined && idx !== null
        ? (Math.max(1, Number(idx) >>> 0) || _newSeed())
        : _newSeed();
    _setSeed(groupJid, t, seed);
}

/**
 * Shuffle the template for a group — assigns a fresh random seed for every
 * theme so the next render always produces a brand-new design.
 *
 * @param {string} groupJid
 */
function resetGroupTemplate(groupJid) {
    const g = String(groupJid || '');
    for (const t of VALID_THEMES) {
        _store[`${g}::${t}`] = { seed: _newSeed() };
    }
    _saveStore();
}

/**
 * Return the current template "index" (seed) for a group+theme.
 * Backward compatible: callers receive the seed integer where they previously
 * received an array index. The meaning is functionally the same — pass it back
 * to renderGodcastTemplate({ templateIndex }) to reproduce the same output.
 *
 * @param {string} groupJid
 * @param {string} [theme]
 * @returns {number}
 */
function getTemplateIndexForGroup(groupJid, theme) {
    return _getSeed(groupJid, theme);
}

// ══════════════════════════════════════════════════════════════════════
// §8  LEGACY COMPAT SHIMS
// ══════════════════════════════════════════════════════════════════════
// Some callers may read CYBER_TEMPLATES[n](link), GIRLY_TEMPLATES.length, etc.
// We expose Proxy-backed virtual arrays that render on-the-fly.
// .length reports 999999 so any bounds check passes.
// Numeric property access returns a render function: (link) => string

function _virtualTemplateArray(theme) {
    const handler = {
        get(_, prop) {
            const n = Number(prop);
            if (Number.isFinite(n) && !Number.isNaN(n))
                return (link) => _generate(Math.max(1, n | 0) || 1, theme, link);
            if (prop === 'length') return 999999;
            return undefined;
        },
    };
    return new Proxy(Object.freeze([]), handler);
}

const CYBER_TEMPLATES  = _virtualTemplateArray('cyber');
const GIRLY_TEMPLATES  = _virtualTemplateArray('girly');
const GUYS_TEMPLATES   = _virtualTemplateArray('guys');

// ══════════════════════════════════════════════════════════════════════
// §9  EXPORTS
// ══════════════════════════════════════════════════════════════════════

module.exports = {
    // ── Core public API (required by all callers) ─────────────────────
    renderGodcastTemplate,
    assignGroupTemplate,
    resetGroupTemplate,
    getActiveTheme,
    setActiveTheme,
    getTemplateIndexForGroup,

    // ── Theme metadata ────────────────────────────────────────────────
    VALID_THEMES,
    TEMPLATE_COUNT: 999999,        // virtual; any seed is valid

    // ── Legacy array compat ───────────────────────────────────────────
    CYBER_TEMPLATES,
    GIRLY_TEMPLATES,
    GUYS_TEMPLATES,
    TEMPLATES: CYBER_TEMPLATES,    // alias used by some older callers
};
