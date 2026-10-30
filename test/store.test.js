import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../src/store.js';
import { setup } from './helpers/setup.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mbta-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('absent, saved, read back', async (t) => {
  const file = join(await tempDir(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(store.load(), { status: 'absent', data: {} });
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(store.load(), { status: 'ok', data: { a: 2 } });
});

test('an unreadable file is unreadable, not empty, and the app never overwrites it', async (t) => {
  const file = join(await tempDir(t), 'state.json');
  await writeFile(file, '{"lastAttemptAt": 12', 'utf8');
  const store = createFileStore(file);
  assert.equal(store.load().status, 'unreadable');
  await writeFile(file, '[1, 2]', 'utf8');
  assert.equal(store.load().status, 'unreadable');
  const { begin, app } = await setup({ store });
  await begin();
  await app.stop();
  assert.equal(await readFile(file, 'utf8'), '[1, 2]');
});
