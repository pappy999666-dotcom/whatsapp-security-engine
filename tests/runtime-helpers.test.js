'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mutateMessage } = require('../core/stealthEngine');
const { createSendWrappers } = require('../core/pluginRunner');
const responses = require('../lib/responses');

test('message mutation resolves spintax without invisible characters', () => {
  for (let index = 0; index < 20; index += 1) {
    const output = mutateMessage('{Hello|Hi} there');
    assert.match(output, /^(Hello|Hi) there$/);
    assert.doesNotMatch(output, /[\u200B-\u200D\uFEFF]/);
  }
});

test('send wrapper scopes delivery and returns sent text', async () => {
  const calls = [];
  const sock = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (...args) => { calls.push(args); return { key: { id: '1' } }; },
  };
  const msg = { key: { remoteJid: '123@s.whatsapp.net' } };
  const wrappers = createSendWrappers({ sock, msg });
  await wrappers.sendReply('Hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], msg.key.remoteJid);
  assert.equal(calls[0][1].text, 'Hello');
  assert.deepEqual(wrappers.sentTexts, ['Hello']);
});

test('response helpers cap buttons and sanitize control characters', () => {
  const payload = responses.interactive({ text: 'Hi\u0000', buttons: [1, 2, 3, 4].map((id) => ({ id: String(id), text: `B${id}` })) });
  assert.equal(payload.text, 'Hi');
  assert.equal(payload.buttons.length, 3);
  assert.match(responses.progress('Work', 5, 10), /50%/);
});
