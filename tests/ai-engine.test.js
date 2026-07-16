'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.join(os.tmpdir(), `pappy-ai-${process.pid}`);
process.env.PAPPY_DATA_ROOT = root;
process.env.SESSION_SECRET = 'test-only-secret-with-enough-entropy';
const store = require('../core/userDataStore');
const { createAiEngine, encryptApiKey, decryptApiKey, AiEngineError } = require('../core/aiEngine');

test.after(async () => {
  await store.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('encrypts credentials without storing plaintext', () => {
  const encrypted = encryptApiKey('top-secret');
  assert.notEqual(encrypted, 'top-secret');
  assert.equal(decryptApiKey(encrypted), 'top-secret');
});

test('fails safely when the encryption secret is missing', () => {
  const secret = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  assert.throws(() => encryptApiKey('secret'), (error) => error instanceof AiEngineError && error.code === 'MISSING_SESSION_SECRET');
  process.env.SESSION_SECRET = secret;
});

test('isolates AI configuration and history by owner and chat', async () => {
  await store.init();
  await Promise.all([store.ensureUser('3001'), store.ensureUser('3002')]);
  const fakeFetch = async () => ({ ok: true, json: async () => ({ message: { content: 'OK' } }) });
  const first = createAiEngine('3001', { fetch: fakeFetch });
  const second = createAiEngine('3002', { fetch: fakeFetch });
  await first.configure({ provider: 'ollama', model: 'phi3:mini' });

  assert.equal((await first.getConfig()).model, 'phi3:mini');
  assert.equal((await second.getConfig()).enabled, false);
  assert.equal(await first.complete({ chatJid: 'chat-a', prompt: 'hello' }), 'OK');
  assert.equal((await first.history('chat-a')).length, 2);
  assert.equal((await first.history('chat-b')).length, 0);
  assert.equal((await second.history('chat-a')).length, 0);
});

test('preserves credentials and isolates group mode while reconfiguring', async () => {
  await store.ensureUser('3004');
  const engine = createAiEngine('3004', { fetch: async () => ({ ok: true, json: async () => ({ message: { content: 'OK' } }) }) });
  await engine.configure({ provider: 'ollama', model: 'phi3:mini', apiKey: 'local-secret' });
  const before = await engine.getConfig();
  await engine.setGroupMode('group-one@g.us', true);
  await engine.configure({ provider: 'ollama', model: 'llava:latest', customPrompt: 'Be brief.' });
  const after = await engine.getConfig();
  assert.equal(after.apiKeyEncrypted, before.apiKeyEncrypted);
  assert.equal(await engine.isGroupEnabled('group-one@g.us'), true);
  assert.equal(await engine.isGroupEnabled('group-two@g.us'), false);
  await engine.setGroupMode('group-one@g.us', false);
  assert.equal(await engine.isGroupEnabled('group-one@g.us'), false);
});

test('clears one chat history without affecting another', async () => {
  await store.ensureUser('3005');
  const engine = createAiEngine('3005', { fetch: async () => ({ ok: true, json: async () => ({ message: { content: 'OK' } }) }) });
  await engine.configure({ provider: 'ollama', model: 'phi3:mini' });
  await engine.complete({ chatJid: 'chat-one', prompt: 'one' });
  await engine.complete({ chatJid: 'chat-two', prompt: 'two' });
  await engine.clearHistory('chat-one');
  assert.equal((await engine.history('chat-one')).length, 0);
  assert.equal((await engine.history('chat-two')).length, 2);
});

test('rejects image requests for non-vision models', async () => {
  await store.ensureUser('3003');
  const engine = createAiEngine('3003', { fetch: async () => { throw new Error('must not call'); } });
  await engine.configure({ provider: 'ollama', model: 'phi3:mini' });
  await assert.rejects(engine.complete({ chatJid: 'chat', prompt: 'inspect', imageUrl: 'https://example.com/a.jpg' }), (error) => error.code === 'VISION_UNSUPPORTED');
});
