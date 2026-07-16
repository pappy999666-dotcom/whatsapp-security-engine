// core/stealthEngine.js
// 🧠 SUPREME GOD MODE: BEHAVIORAL & STEALTH ENGINE (Zero-Crash Edition)

const logger = require('./logger');

const randomDelay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

const hesitate = async (baseMs = 1000) => {
    const jitter = Math.floor(Math.random() * 1500) - 500; 
    await randomDelay(Math.max(baseMs + jitter, 500), baseMs + jitter + 500);
};

const applyPersonality = (text) => {
    const personalities = ['normal', 'spaced'];
    const mode = personalities[Math.floor(Math.random() * personalities.length)];
    if (mode === 'spaced') {
        // Adds spacing but prevents ridiculously long empty gaps
        return text.replace(/\n/g, '\n\n').replace(/\n\n\n/g, '\n\n'); 
    }
    return text;
};

// 🚀 BULLETPROOF SPINTAX RESOLVER (Handles Nested Spintax Flawlessly)
const resolveSpintax = (text) => {
    if (!text) return '';
    const regex = /\{([^{}]*)\}/; // Targets the innermost brackets first
    let match;
    while ((match = regex.exec(text)) !== null) {
        const options = match[1].split('|');
        const randomOption = options[Math.floor(Math.random() * options.length)];
        text = text.replace(match[0], randomOption);
    }
    return text;
};

// 🧬 THE MUTATOR (With Zero-Crash Guarantee)
const mutateMessage = (text) => {
    if (!text) return '';
    try {
        // Spintax is the only permitted mutation. Invisible characters and
        // spacing tricks can corrupt content and increase account risk.
        return resolveSpintax(String(text));
    } catch {
        return String(text);
    }
};

// 🧠 DYNAMIC HUMAN TYPING SIMULATOR
const simulateHumanInteraction = async (sock, jid, textToType = '') => {
    try {
        await sock.sendPresenceUpdate('composing', jid);
        
        // Dynamic typing calculation: ~50ms per character, capped at 4 seconds.
        let typingDuration = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
        if (textToType) {
            typingDuration = Math.min(textToType.length * 50, 4000) + Math.floor(Math.random() * 500);
        }
        
        await randomDelay(typingDuration, typingDuration + 500); 
        await sock.sendPresenceUpdate('paused', jid);
        
        // Tiny pause before hitting the 'send' button
        await randomDelay(200, 400); 
    } catch (e) {
        // Fail silently so it never interrupts a broadcast
    }
};

module.exports = { randomDelay, hesitate, mutateMessage, simulateHumanInteraction, resolveSpintax };
