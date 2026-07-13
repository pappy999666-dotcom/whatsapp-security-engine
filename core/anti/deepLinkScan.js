'use strict';
// core/anti/deepLinkScan.js
// ─── DEEP ANTI-LINK — RECURSIVE PROTOBUF INSPECTION ───────────────────────────
// Merged into antiEngine.checkAntiLink / checkAntiInviteLink so the single
// .antilink toggle covers deep protobuf + obfuscation cases.
//
// The existing antiEngine.checkAntiLink only looks at ctx.text/ctx.caption
// (extendedTextMessage / image-video captions). It never looks inside poll
// options, list-message titles/descriptions, or view-once wrappers — so a
// link hidden in a poll option or a list row sails straight through.
//
// This module extracts every piece of user-controlled text from a raw Baileys
// message (recursing into view-once/ephemeral wrappers) and applies an
// obfuscation-aware link/invite detector on top of it.

const INVITE_LINK_RE = /(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?[A-Za-z0-9]{6,30}/gi;
const GENERIC_URL_RE = /(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|me|xyz|info|biz|link|shop|store|club|live|app|dev|gg|to|cc|tv|ws|top|site|online|website)\b(?:\/[^\s]*)?/gi;
const SHORTENER_RE = /\b(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|cutt\.ly|is\.gd|buff\.ly|rebrand\.ly|shorturl\.at|rb\.gy|tiny\.cc|shrtco\.de)\b/i;

// "site dot com", "site (dot) com", "site[dot]com" → site.com
const DOT_WORD_RE = /\s*[\[({]?\s*d\s*o\s*t\s*[\])}]?\s*/gi;
// "site  dot  com" already handled above; also catch " at " → "@" style obfuscation
// used for emails/handles sometimes paired with links, and de-space runs of single
// characters that look like a spaced-out domain, e.g. "s i t e . c o m"
const SPACED_CHAR_RE = /\b(?:[a-zA-Z]\s+){2,}[a-zA-Z]\b/g;

/**
 * deobfuscate — normalize common link-hiding tricks before regex matching.
 * Not perfect (no obfuscation detector is), but catches the common cases:
 * spelled-out "dot", zero-width/invisible characters, and de-spaced text.
 */
function deobfuscate(raw) {
    let text = String(raw || '');
    // Strip zero-width / invisible characters used to break naive regexes
    text = text.replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '');
    // "site dot com" / "site [dot] com" / "site(dot)com" → "site.com"
    text = text.replace(DOT_WORD_RE, '.');
    // Collapse spaced-out runs of single letters ("s i t e . c o m" → "site.com")
    text = text.replace(SPACED_CHAR_RE, (m) => m.replace(/\s+/g, ''));
    return text;
}

/**
 * _collectStrings — recursively pull every human-readable string out of a
 * Baileys message payload that a user could have put a link/invite inside.
 */
function _collectStrings(message, depth = 0, out = []) {
    if (!message || typeof message !== 'object' || depth > 6) return out;

    // Plain text / captions
    if (typeof message.text === 'string') out.push(message.text);
    if (typeof message.caption === 'string') out.push(message.caption);
    if (typeof message.conversation === 'string') out.push(message.conversation);

    // extendedTextMessage
    if (message.extendedTextMessage) _collectStrings(message.extendedTextMessage, depth + 1, out);

    // Media captions
    for (const k of ['imageMessage', 'videoMessage', 'documentMessage']) {
        if (message[k]) _collectStrings(message[k], depth + 1, out);
    }

    // pollCreationMessage / pollCreationMessageV3 — title + every option name
    for (const k of ['pollCreationMessage', 'pollCreationMessageV3']) {
        const poll = message[k];
        if (poll) {
            if (typeof poll.name === 'string') out.push(poll.name);
            for (const opt of (poll.options || [])) {
                if (typeof opt?.optionName === 'string') out.push(opt.optionName);
            }
        }
    }

    // listMessage — title, description, buttonText, and every section/row
    for (const k of ['listMessage', 'listResponseMessage']) {
        const list = message[k];
        if (list) {
            for (const f of ['title', 'description', 'buttonText', 'footerText']) {
                if (typeof list[f] === 'string') out.push(list[f]);
            }
            for (const section of (list.sections || [])) {
                if (typeof section?.title === 'string') out.push(section.title);
                for (const row of (section.rows || [])) {
                    if (typeof row?.title === 'string') out.push(row.title);
                    if (typeof row?.description === 'string') out.push(row.description);
                }
            }
        }
    }

    // buttonsMessage / templateMessage — content + button text
    for (const k of ['buttonsMessage', 'templateMessage']) {
        const btn = message[k];
        if (btn) {
            if (typeof btn.contentText === 'string') out.push(btn.contentText);
            if (typeof btn.footerText === 'string') out.push(btn.footerText);
            for (const b of (btn.buttons || [])) {
                if (typeof b?.buttonText?.displayText === 'string') out.push(b.buttonText.displayText);
            }
        }
    }

    // view-once / ephemeral wrappers — recurse into the inner message
    for (const k of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'ephemeralMessage']) {
        if (message[k]?.message) _collectStrings(message[k].message, depth + 1, out);
    }

    return out;
}

/**
 * scanMessage — deep-inspects a raw Baileys message (msg.message) for links,
 * WhatsApp group-invite links, and known shortener domains hidden anywhere in
 * the protobuf structure (text, poll options, list rows, view-once wrappers).
 *
 * @returns {{ found: boolean, matches: string[], inviteLinks: string[], source: string[] }}
 */
function scanMessage(message) {
    const strings = _collectStrings(message);
    const matches = [];
    const inviteLinks = [];
    const sources = [];

    for (const raw of strings) {
        if (!raw) continue;
        const clean = deobfuscate(raw);

        const invites = clean.match(INVITE_LINK_RE) || [];
        if (invites.length) {
            inviteLinks.push(...invites);
            sources.push(raw.slice(0, 60));
        }

        const urls = (clean.match(GENERIC_URL_RE) || []).filter((u) => !/chat\.whatsapp\.com/i.test(u));
        if (urls.length) {
            matches.push(...urls);
            sources.push(raw.slice(0, 60));
        } else if (SHORTENER_RE.test(clean)) {
            matches.push(clean.match(SHORTENER_RE)[0]);
            sources.push(raw.slice(0, 60));
        }
    }

    return {
        found: matches.length > 0 || inviteLinks.length > 0,
        matches: [...new Set(matches)],
        inviteLinks: [...new Set(inviteLinks)],
        source: [...new Set(sources)],
    };
}

module.exports = { scanMessage, deobfuscate, _collectStrings };
