'use strict';
// core/magicPalette.js — curated rotating aesthetics for the .magiccast group-status engine.
//
// godcast posts one fixed-colour status with a stable per-group design. magiccast is the
// "alive" variant: every group it lands in gets a DIFFERENT colour + font + design combo, so
// a single broadcast paints a rainbow of distinct, aesthetic status cards. Each entry pairs a
// status background colour with a WhatsApp status font id that reads well on it.
//
// WhatsApp status font ids: 0 SansSerif · 1 SerifBold · 2 Norican(script) · 3 BryndanWrite ·
// 4 BebasNeue · 5 OswaldHeavy. We bias toward 2-5 for personality; all colours are dark/jewel
// tones so the default WHITE status text stays high-contrast and readable.

const PALETTE = [
    { bg: '#0B0B0F', font: 3 }, // obsidian
    { bg: '#1A1036', font: 2 }, // deep violet
    { bg: '#3A0CA3', font: 5 }, // electric indigo
    { bg: '#7209B7', font: 2 }, // royal purple
    { bg: '#B5179E', font: 4 }, // orchid magenta
    { bg: '#F72585', font: 3 }, // hot pink
    { bg: '#D00000', font: 4 }, // crimson
    { bg: '#E85D04', font: 5 }, // burnt orange
    { bg: '#0F7B6C', font: 3 }, // teal
    { bg: '#06A77D', font: 2 }, // emerald
    { bg: '#118AB2', font: 5 }, // ocean blue
    { bg: '#1D3557', font: 3 }, // midnight navy
    { bg: '#2B2D42', font: 2 }, // slate
    { bg: '#5F0F40', font: 4 }, // wine
    { bg: '#240046', font: 5 }, // void purple
    { bg: '#4361EE', font: 3 }, // azure
];

// Rotating cursor — lives for the life of the worker process. Stepping by a value coprime to
// the palette length guarantees we cycle through every colour before repeating.
let _rot = Math.floor(Math.random() * PALETTE.length);
const STEP = 7; // coprime with 16

function hashStr(s) {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

// Pick a per-group aesthetic. Combines a hash of the group JID (so neighbours differ) with the
// rotating cursor (so the SAME group shifts colour on each new broadcast) → always "changing".
function pickAesthetic(groupJid, salt = 0) {
    const idx = (hashStr(groupJid) + _rot + Number(salt || 0)) % PALETTE.length;
    _rot = (_rot + STEP) % PALETTE.length;
    const entry = PALETTE[idx] || PALETTE[0];
    return { bg: entry.bg, font: entry.font, index: idx };
}

module.exports = { PALETTE, PALETTE_COUNT: PALETTE.length, pickAesthetic, hashStr };
