'use strict';

const { resolveOwnerContext } = require('./resolveTgOwner');
const { simulateHumanInteraction, mutateMessage } = require('./stealthEngine');
const { createAiEngine } = require('./aiEngine');

function abortError() { const error = new Error('Command aborted'); error.name = 'AbortError'; return error; }
function createSendWrappers({ sock, msg, abortSignal }) {
  const defaultJid = msg?.key?.remoteJid;
  const sentTexts = [];
  const sendMessage = async (jid, content, options = {}) => {
    if (abortSignal?.aborted) throw abortError();
    const target = jid || defaultJid;
    if (!target) throw new TypeError('A target JID is required');
    const payload = { ...content };
    if (typeof payload.text === 'string') payload.text = mutateMessage(payload.text);
    const preview = payload.text || payload.caption || '';
    await simulateHumanInteraction(sock, target, preview);
    const result = await sock.sendMessage(target, payload, options);
    if (preview) sentTexts.push(preview);
    return result;
  };
  const sendReply = (content, options = {}) => sendMessage(defaultJid, typeof content === 'string' ? { text: content } : content, { quoted: msg, ...options });
  return { sendMessage, sendReply, sentTexts };
}
async function runPlugin({ command, sock, msg, args, text, user, isGroup, botId, commandName, abortSignal, softWorkDelay }) {
  const { tgUserId, userStore } = resolveOwnerContext({ botId, sock });
  const wrappers = createSendWrappers({ sock, msg, abortSignal });
  const context = { sock, msg, args, text, user, isGroup, botId, commandName, abortSignal, softWorkDelay, tgUserId, userStore, ai: createAiEngine(tgUserId), ...wrappers };
  if (command.execute.length === 1) await command.execute(context);
  else await command.execute(sock, msg, args, user, commandName, abortSignal, context);
  return wrappers.sentTexts.slice();
}
module.exports = { createSendWrappers, runPlugin };
