'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.join(os.tmpdir(), `pappy-isolation-${process.pid}`);
process.env.PAPPY_DATA_ROOT = root;
const store = require('../core/userDataStore');

test.after(async () => {
  await store.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('creates isolated defaults for each Telegram owner', async () => {
  await store.init();
  await Promise.all([store.ensureUser('1001'), store.ensureUser('1002')]);
  await store.update('1001', 'config', (value) => ({ ...value, botName: 'Alpha' }));

  assert.equal((await store.get('1001', 'config')).botName, 'Alpha');
  assert.equal((await store.get('1002', 'config')).botName, 'Pappy');
  assert.notEqual(store.bind('1001').root, store.bind('1002').root);
});

test('debounced hot data is persisted by flush', async () => {
  await store.ensureUser('2001');
  await store.set('2001', 'economy', { users: { a: { coins: 50 } } });
  await store.flush('2001');
  const body = JSON.parse(await fs.readFile(path.join(root, 'users', '2001', 'economy.json'), 'utf8'));
  assert.equal(body.users.a.coins, 50);
});

test('rejects traversal and unknown namespaces', async () => {
  assert.throws(() => store.bind('../other'), /Invalid Telegram user id/);
  await assert.rejects(store.get('1001', 'missing'), /Unknown user namespace/);
});
