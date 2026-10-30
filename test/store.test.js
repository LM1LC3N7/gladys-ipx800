import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';

test('fileStore: atomic 0600 write, missing = null, unreadable throws', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ipx800-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { a: 2 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{not json');
  await assert.rejects(store.load());
});

test('normalizeMemory: bounded, dates brought to now, guards checked, another key starts empty', () => {
  const now = Date.UTC(2026, 9, 27);
  const memory = normalizeMemory(
    {
      lastAttemptAt: now + 3600_000,
      key: 'a'.repeat(32),
      pause: { until: now + 100 * 3600_000, failures: 99, code: 'busy' },
      refused: { salt: 'b'.repeat(32), tag: 300 },
      guards: [
        { code: 'fp1', kind: 'pilot-wire', value: 0, resends: 2, confirmed: false },
        { code: 'fp1', kind: 'pilot-wire', value: 1 },
        { code: '__proto__', kind: 'relay', value: 0 },
        { code: 'r1', kind: 'relay', value: 9 },
        { code: 'r2', kind: 'relay', value: 1 },
        { code: 'fp2', kind: 'pilot-wire', value: 5 },
      ],
      layout: { r1: { kind: 'relay', state: 110, command: 100 } },
    },
    now,
  );
  assert.equal(memory.lastAttemptAt, now);
  assert.equal(memory.pause.until, now + 3600_000);
  assert.equal(memory.pause.failures, 10);
  assert.equal(memory.refused, null);
  assert.deepEqual(
    memory.guards.map((g) => g.code),
    ['fp1'],
  );
  assert.equal(memory.guards[0].resends, 2);
  assert.ok(memory.layout.r1);
  assert.deepEqual(normalizeMemory({ key: 'nope', guards: [{ code: 'fp1' }] }).guards, []);
});

test('normalizeMemory: a file of 0.1.2 names its controller as the owner, marked legacy', () => {
  const key = 'c'.repeat(32);
  const legacy = normalizeMemory({ key, guards: [] });
  assert.deepEqual(legacy.owner, { kind: 'address', id: key, at: key, legacy: true });
  assert.equal(legacy.format, 2);
  assert.equal(normalizeMemory({ guards: [] }).owner, null, 'no key: no owner');
  assert.equal(normalizeMemory(null).owner, null, 'a fresh install');
  const owner = { kind: 'mac', id: 'd'.repeat(32), at: key };
  assert.deepEqual(normalizeMemory({ format: 2, key, owner, salt: 'e'.repeat(32) }).owner, owner);
  assert.equal(normalizeMemory({ format: 2, key, salt: 'e'.repeat(32) }).salt, 'e'.repeat(32));
  for (const bad of [
    { kind: 'serial', id: 'd'.repeat(32) },
    { kind: 'mac', id: '00:04:a3:00:00:01' },
    { kind: 'mac' },
    'mac',
  ]) {
    assert.equal(normalizeMemory({ format: 2, key, owner: bad }).owner, null, JSON.stringify(bad));
  }
  assert.equal(normalizeMemory({ format: 2, key, salt: 'nope' }).salt, '');
  // The owner survives another controller key (it is about the devices, not the address).
  assert.deepEqual(normalizeMemory({ format: 2, key: 'f'.repeat(32), owner }).owner, owner);
});
