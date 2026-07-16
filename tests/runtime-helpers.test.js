'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('WhatsApp rich reply helpers implement the response specification', () => {
  assert.equal(responses.buildHeader('Nexus'), '*「 NEXUS 」*\n─────────────────');
  assert.equal(responses.buildDivider(), '─────────────────');
  assert.equal(responses.buildProgressBar(5, 10), '▓▓▓▓▓░░░░░ 50%');
  assert.equal(responses.truncate('abcdef', 5), 'ab...');
  assert.equal(responses.formatUptime(8052000), '2h 14m 12s');
  assert.equal(responses.formatNumber(1234), '1,234');
  assert.equal(responses.medalFor(10), '🔟');
  assert.equal(
    responses.buildTreeList([{ icon: '🔧', label: 'Utility', value: '.menu utility' }, { icon: '👑', label: 'Owner', value: '.menu owner' }]),
    '┌─ 🔧 Utility — .menu utility\n└─ 👑 Owner — .menu owner'
  );

  const card = responses.buildContextCard({ title: 'PAPPY ULTIMATE', body: 'Menu', thumbnailUrl: 'https://example.com/a.jpg', text: 'Hello', nodeMode: 'public' });
  assert.equal(card.contextInfo.externalAdReply.previewType, 0);
  assert.equal(card.contextInfo.externalAdReply.showAdAttribution, false);
  assert.equal(card.contextInfo.externalAdReply.thumbnailUrl, 'https://example.com/a.jpg');
  assert.match(card.text, /powered by Pappy Ultimate · public/);
});

test('WhatsApp plugin inventory exposes at least 150 unique commands', () => {
  const pluginDir = path.join(__dirname, '../plugins');
  const commands = new Set();
  for (const file of fs.readdirSync(pluginDir).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(pluginDir, file), 'utf8');
    for (const match of source.matchAll(/cmd:\s*['"]([^'"]+)['"]/g)) commands.add(match[1].toLowerCase());
  }
  assert.ok(commands.size >= 150, `expected at least 150 unique commands, found ${commands.size}`);
});
