'use strict';
// core/security/variableInjector.js
// ─── VARIABLE INJECTION ENGINE ─────────────────────────────────────────────────
// Dynamic token replacement for security-action messages. Every token is
// replaced independently (order does not matter, none of the tokens can
// contain another token's syntax) so a single pass over the map is sufficient
// — described as "recursive" in the sense that every occurrence of every token
// in the template is replaced, not just the first.

/**
 * renderTemplate — replace $desc/$pp/$gcname/$size/$rsn/$count/$mention/&num
 * tokens in `template` using values from `vars`. Any token with no value
 * resolves to an empty string rather than leaving the raw token in the output.
 *
 * @param {string} template
 * @param {object} vars
 * @param {string} [vars.desc]    — group description
 * @param {string} [vars.pp]      — profile picture URL
 * @param {string} [vars.gcname]  — group name/subject
 * @param {number} [vars.size]    — member count
 * @param {string} [vars.rsn]     — violation reason
 * @param {number} [vars.count]   — warn count
 * @param {string} [vars.mentionJid] — JID to render as an @mention
 * @param {string} [vars.num]     — phone number (digits or full JID)
 * @returns {{ text: string, mentions: string[] }}
 */
function renderTemplate(template, vars = {}) {
    let text = String(template || '');
    const mentions = [];

    const mentionJid = vars.mentionJid;
    const mentionTag = mentionJid ? `@${String(mentionJid).split('@')[0]}` : '';
    if (mentionJid && text.includes('$mention')) mentions.push(mentionJid);

    const TOKENS = {
        '$desc':   vars.desc != null ? String(vars.desc) : '',
        '$pp':     vars.pp != null ? String(vars.pp) : '',
        '$gcname': vars.gcname != null ? String(vars.gcname) : '',
        '$size':   vars.size != null ? String(vars.size) : '',
        '$rsn':    vars.rsn != null ? String(vars.rsn) : '',
        '$count':  vars.count != null ? String(vars.count) : '',
        '$mention': mentionTag,
        '&num':    vars.num != null ? String(vars.num) : '',
    };

    for (const [token, value] of Object.entries(TOKENS)) {
        // Escape regex special chars in the token itself ($ and &)
        const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&'), 'g');
        text = text.replace(re, value);
    }

    return { text, mentions };
}

module.exports = { renderTemplate };
