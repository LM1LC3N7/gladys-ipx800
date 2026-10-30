// -----------------------------------------------------------------------------
// /data and the Offs (review r4 of 7786d42): every read and save of /data is
// bounded (a frozen disk never stops the reads, the status, the test button
// nor an Off); in the states where only Offs go, an Off that does not take is
// still sent again by the reads; devices whose IPX800 is not known (no /data)
// get their Offs at the address typed whatever /data can hold; the Offs held
// in memory survive a new session; two slots with the same address keep the
// one verified there. Virtual clock, fake IPX800, the SDK's fake Gladys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IpxHub } from '../src/hub.js';
import { registerHandlers } from '../src/handlers.js';
import { normalizeConfig, sessionKey, slotConfigs } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { T } from '../src/i18n.js';
import { PRIORITY } from '../src/ipx/client.js';
import { fileStore, memoryStore } from '../src/store.js';
import { testClock } from './kit/index.mjs';
import { KEY, fakeIpx } from './helpers/fakeIpx.js';
import {
  CONFIG,
  F,
  SALT,
  SECOND,
  START,
  boundMemory,
  created,
  settle,
  setup,
} from './helpers/app.js';

const message = (gladys, lang = 'en') => gladys.fake.connectionStatus?.message?.[lang] ?? '';
const discovered = (gladys) => (gladys.fake.discoveredDevices ?? []).map((d) => d.external_id);
const switchOf = (code) => created('relay', code, { relayKind: 'switch' });
const V5_R1 = { ...CONFIG.v5, relays: 'R1' };
const V4_R1 = { ...CONFIG.v4, relays: 'R1' };

/** A memory store whose saves and loads can hang (a frozen disk); `release()` ends those held. */
function frozenStore(initial = null) {
  const store = memoryStore(initial);
  const save = store.save.bind(store);
  const load = store.load.bind(store);
  store.hangSaves = false;
  store.hangLoads = false;
  store.held = [];
  store.loads = 0;
  store.save = (data) => {
    if (!store.hangSaves) return save(data);
    const copy = structuredClone(data);
    return new Promise((resolve) => store.held.push(() => resolve(save(copy))));
  };
  store.load = () => {
    store.loads += 1;
    if (!store.hangLoads) return load();
    return new Promise((resolve) => store.held.push(() => resolve(load())));
  };
  store.release = async () => {
    for (const end of store.held.splice(0)) end();
    await settle();
  };
  return store;
}

const rounds = (world) =>
  world.requests.filter((r) => /\/api\/system\/ipx|Get=all/.test(r.path)).length;
const offs = (world) =>
  world
    .writes()
    .filter((r) => r.sentAt !== undefined && (/ClearR=01/.test(r.path) || r.body?.on === false))
    .length;

// --- B1: bounded /data ---------------------------------------------------------------------

test('B1 (H1): a save that hangs while running: reads go on, the test button answers, the status is true, Offs leave', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = frozenStore();
  const { app, gladys, start, wait, cmd, act } = await setup({
    version: 'v5',
    config: { ...V5_R1, poll_interval: 5 },
    devices: [device],
    world,
    store,
  });
  await start();
  store.hangSaves = true;
  const before = rounds(world);
  await wait(16 * SECOND);
  assert.ok(rounds(world) - before >= 2, `${rounds(world) - before} rounds`);
  // One save at a time: the one that hangs is not stacked on (each would hold a thread).
  assert.equal(store.held.length, 1);
  assert.match(message(gladys), /Connected to the IPX800 V5/);
  assert.match(message(gladys), /cannot be written to \/data/);
  const answer = await act(app.testConnection());
  assert.notDeepEqual(answer, T.test.busy, 'the test button never waits for /data');
  // A clicked Off leaves at once; the next ones too.
  world.io.set(110, true);
  for (let i = 0; i < 3; i += 1) {
    const ack = await cmd(device, F('relay', 'r1', 'switch'), 0);
    assert.equal(ack.success, true, ack.error);
  }
  assert.equal(offs(world), 3);
  // The IPX800 goes away: said, never "Connected" with the values of before.
  world.refuseConnect = 1000;
  await wait(12 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys), /does not answer/);
  // Held while it is away (no connection), sent again once it answers.
  world.io.set(110, true);
  const kept = await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.match(kept.error, /gardée et renvoyée/);
  world.refuseConnect = 0;
  await wait(70 * SECOND);
  assert.equal(world.io.get(110), false, 'the Off held went once the IPX800 answered');
  // Once the frozen save ends, the state of now is written.
  store.hangSaves = false;
  const saves = store.saves;
  await store.release();
  await wait(100);
  assert.ok(store.saves >= saves + 2, 'the frozen one, then the state of now');
  assert.equal(app.saveFailed, false);
  app.stop();
});

test('B1 (H3): a save that hangs from the start (file there): the start ends, rounds and status follow', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = frozenStore(boundMemory(V5_R1));
  store.hangSaves = true;
  const { app, gladys, wait, act } = await setup({
    version: 'v5',
    config: { ...V5_R1, poll_interval: 5 },
    devices: [device],
    world,
    store,
  });
  const t0 = app.monotonic();
  await act(app.connected({ ...V5_R1, poll_interval: 5 }));
  assert.ok(app.monotonic() - t0 < 2 * TIMINGS.storeWait, 'the start never waits for ever');
  assert.match(message(gladys), /Connecting to the IPX800….*cannot be written to \/data/);
  await wait(12 * SECOND);
  assert.ok(rounds(world) >= 2, `${rounds(world)} rounds`);
  assert.match(message(gladys), /Connected to the IPX800 V5.*cannot be written to \/data/);
  world.io.set(110, true);
  const off = await act(
    gladys.fake.setValue(device, { external_id: F('relay', 'r1', 'switch') }, 0),
  );
  assert.equal(off.success, true, off.error);
  app.stop();
});

test('B1 (H2): no file, devices there, the first save hangs (the probe of storeLost): an Off clicked leaves', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = frozenStore();
  store.hangSaves = true;
  const { app, gladys, act } = await setup({
    version: 'v5',
    config: V5_R1,
    devices: [device],
    world,
    store,
    fresh: true,
  });
  const starting = app.connected(V5_R1);
  world.io.set(110, true);
  const clicked = app.monotonic();
  const ack = await act(
    gladys.fake.setValue(device, { external_id: F('relay', 'r1', 'switch') }, 0),
  );
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.io.get(110), false);
  // No V5 id in /data: it left right after the first read (the probe took its 1.5 s).
  const left = world.writes().find((w) => w.body?.on === false).sentAt - clicked;
  assert.ok(left < TIMINGS.storeWait + 500, `left ${left} ms after the click`);
  await act(starting);
  assert.equal(app.storeLost, true);
  assert.match(message(gladys), /cannot be written to \/data and holds nothing yet/);
  app.stop();
});

test('B1 (L2): a load that hangs at the start of the container: unreadable, an Off clicked leaves to the address typed', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = frozenStore(boundMemory(V5_R1));
  store.hangLoads = true;
  const { app, gladys, act, wait } = await setup({
    version: 'v5',
    config: V5_R1,
    devices: [device],
    world,
    store,
  });
  const starting = app.connected(V5_R1);
  await wait(500);
  world.io.set(110, true);
  const ack = await act(
    gladys.fake.setValue(device, { external_id: F('relay', 'r1', 'switch') }, 0),
  );
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.io.get(110), false);
  await act(starting);
  assert.equal(app.storeUnreadable, true);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys), /state in \/data cannot be read/);
  const on = await act(
    gladys.fake.setValue(device, { external_id: F('relay', 'r1', 'switch') }, 1),
  );
  assert.equal(on.success, false);
  // One read of /data at a time: a read that hangs is never stacked on.
  await wait(30 * SECOND);
  assert.equal(store.loads, 1);
  assert.equal(store.saves, 0, 'never written over unseen');
  // It reads again: the owner of the file, the verdict worked out again, everything back.
  store.hangLoads = false;
  await store.release();
  await wait(15 * SECOND);
  assert.equal(app.storeUnreadable, false);
  assert.equal(app.verdict, 'same');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  app.stop();
});

test('B1 (L1): a load that hangs at a session reset (new API key): an Off clicked meanwhile leaves', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = frozenStore();
  const { app, gladys, start, act, wait } = await setup({
    version: 'v5',
    config: V5_R1,
    devices: [device],
    world,
    store,
  });
  await start();
  store.hangLoads = true;
  world.key = 'new-key';
  const saving = gladys.fake.configUpdated({ ...V5_R1, api_key: 'new-key' });
  await wait(300);
  world.io.set(110, true);
  const ack = await act(
    gladys.fake.setValue(device, { external_id: F('relay', 'r1', 'switch') }, 0),
  );
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.io.get(110), false);
  await act(saving);
  assert.match(message(gladys), /state in \/data cannot be read/);
  assert.equal(gladys.fake.connectionStatus.connected, false, 'never "Connected" meanwhile');
  app.stop();
});

test('B1: a save asked while one runs is answered by a save of the state of its own time', async () => {
  const store = frozenStore();
  const { app, start, clock, act } = await setup({ store });
  await start();
  const save = store.save;
  store.save = async (data) => {
    // The state as it is when the save is asked for (fileStore serializes it at once too).
    const copy = structuredClone(data);
    await new Promise((r) => clock.timers.setTimeout(r, 200));
    return save(copy);
  };
  app.memory.lastAttemptAt = 1;
  const first = app.saveMemory();
  await act(new Promise((r) => clock.timers.setTimeout(r, 50)));
  app.memory.lastAttemptAt = 2;
  const second = app.saveMemory();
  assert.equal(await act(first), true);
  assert.equal(await act(second), true);
  assert.equal(store.data.lastAttemptAt, 2, 'written after the change it was asked for');
  app.stop();
});

test('B1: fileStore never waits behind a write that hangs, and an older write never lands over a newer one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ipx800-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  let hang = true;
  const held = [];
  const fs = {
    ...fsPromises,
    async open(file, flags, mode) {
      const handle = await fsPromises.open(file, flags, mode);
      if (!hang) return handle;
      hang = false;
      // The first write freezes before its bytes until released (they then land in its file).
      return {
        writeFile: (...args) =>
          new Promise((resolve) => held.push(() => resolve(handle.writeFile(...args)))),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };
  const clock = testClock({ start: START });
  const store = fileStore(path, { fs, timers: clock.timers, queueWait: 1000 });
  const first = store.save({ n: 1 });
  let firstDone = false;
  first.then(() => (firstDone = true));
  const second = store.save({ n: 2 });
  let secondDone = false;
  second.then(() => (secondDone = true));
  await settle();
  assert.equal(secondDone, false, 'in order while the first may still end');
  await clock.advance(1000);
  // Real file writes: real time for them (the clock only stands for the wait in the queue).
  for (let i = 0; i < 200 && !secondDone; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(secondDone, true, 'not stuck behind the frozen write');
  assert.equal(firstDone, false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 2 });
  held.shift()();
  await first;
  assert.deepEqual(
    JSON.parse(await readFile(path, 'utf8')),
    { n: 2 },
    'the older never lands, not even in the file of the newer',
  );
  assert.deepEqual(await readdir(dir), ['state.json'], 'no temporary file left');
  await store.save({ n: 3 });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 3 });
});

test('B1: /data that reads again mid-session: the MAC judged under the salt of the file, the Offs held stay', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = memoryStore(boundMemory(V5_R1));
  store.unreadable = true;
  const config = { ...V5_R1, poll_interval: 5 };
  const { app, start, wait, cmd } = await setup({
    version: 'v5',
    config,
    devices: [device],
    world,
    store,
  });
  await start(config);
  assert.equal(app.verdict, 'unbound');
  world.io.set(110, true);
  world.ignoreWrites = true;
  await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.ok(app.guards.has('r1'));
  store.unreadable = false;
  await wait(6 * SECOND);
  assert.equal(app.storeUnreadable, false);
  assert.equal(app.verdict, 'same');
  assert.ok(app.guards.has('r1'), 'the Off held for this IPX800 is still held');
  app.stop();
});

test('I4: the presumption of 0.1.2 is not a verified owner (it never keeps an address over a slot verified there)', async () => {
  const { app, start } = await setup({
    config: V4_R1,
    devices: [switchOf('r1')],
    store: memoryStore(legacyMemory(V4_R1)),
  });
  await start();
  assert.equal(app.verdict, 'presumed');
  assert.equal(await app.verifiedAt(), undefined);
  app.stop();
  const bound = await setup({ config: V4_R1, devices: [switchOf('r1')] });
  await bound.start();
  assert.equal(await bound.app.verifiedAt(), normalizeConfig(V4_R1).key);
  bound.app.stop();
});

test('B1: /data that fails, then writes again, is said in the status at once', async () => {
  const store = memoryStore();
  const { app, gladys, start } = await setup({ store });
  await start();
  assert.doesNotMatch(message(gladys), /\/data/);
  store.fail = true;
  assert.equal(await app.saveMemory(), false);
  await settle();
  assert.match(message(gladys), /cannot be written to \/data/);
  store.fail = false;
  assert.equal(await app.saveMemory(), true);
  await settle();
  assert.doesNotMatch(message(gladys), /\/data/);
  app.stop();
});

test('B1: /data readable again between two rounds: the verdict from the file at once', async () => {
  const device = switchOf('r1');
  const store = memoryStore(boundMemory(V4_R1));
  store.unreadable = true;
  const config = { ...V4_R1, poll_interval: 60 };
  const { app, start, cmd, act } = await setup({ config, devices: [device], store });
  await start(config);
  assert.equal(app.verdict, 'unbound');
  store.unreadable = false;
  assert.equal(await act(app.saveMemory()), true);
  assert.equal(app.verdict, 'same', 'not only at the next round');
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 1)).success, true);
  app.stop();
});

test('B1: /data readable again before any good round: the verdict from the file at once', async () => {
  const device = switchOf('r1');
  const store = memoryStore(boundMemory(V4_R1));
  store.unreadable = true;
  const world = fakeIpx();
  world.refuseConnect = 1000;
  const { app, start, act } = await setup({ config: V4_R1, devices: [device], store, world });
  await start();
  assert.equal(app.verdict, 'unbound');
  assert.equal(app.round, undefined);
  store.unreadable = false;
  assert.equal(await act(app.saveMemory()), true);
  assert.equal(app.verdict, 'same');
  app.stop();
});

// --- I1: Offs sent again where only Offs go -------------------------------------------------

/** A 0.1.2 /data (no `format`): the controller key it read last. */
const legacyMemory = (raw) => ({
  lastAttemptAt: null,
  key: normalizeConfig(raw).key,
  pause: null,
  refused: null,
  layout: {},
  guards: [],
});

for (const state of ['presumed', 'no /data', 'storeLost', 'unreadable']) {
  test(`I1: ${state}: an Off the IPX800 does not apply is sent again by the reads, nothing published`, async () => {
    const device = switchOf('r1');
    const world = fakeIpx();
    const store = memoryStore(state === 'presumed' ? legacyMemory(V4_R1) : null);
    if (state === 'storeLost') store.fail = true;
    if (state === 'unreadable') store.unreadable = true;
    const config = { ...V4_R1, poll_interval: 5 };
    const { app, gladys, start, wait, cmd } = await setup({
      config,
      devices: [device],
      world,
      store,
      fresh: true,
    });
    await start(config);
    assert.equal(app.verdict, state === 'presumed' ? 'presumed' : 'unbound');
    assert.equal(app.mayDrive(true), true);
    world.R[1] = 1;
    world.ignoreWrites = true;
    const ack = await cmd(device, F('relay', 'r1', 'switch'), 0);
    assert.match(ack.error, /pas encore appliquée/);
    await wait(30 * SECOND);
    assert.equal(offs(world), 1 + TIMINGS.resendMax, 'sent again 3 times, then said');
    assert.match(message(gladys), /Off \/ Frost protection not applied after 3 tries.*R1/);
    assert.equal(gladys.fake.connectionStatus.connected, false);
    await app.flush();
    assert.equal(gladys.fake.lastState(F('relay', 'r1', 'switch')), undefined, 'no value');
    assert.deepEqual(discovered(gladys), []);
    app.stop();
  });
}

test('I1: a V5 whose MAC is to be read again (after a failed round): a read back sends no Off before that check', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const { app, start, cmd, act } = await setup({
    version: 'v5',
    config: V5_R1,
    devices: [device],
    world,
  });
  await start();
  world.io.set(110, true);
  world.ignoreWrites = true;
  await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.ok(app.guards.has('r1'));
  app.recheck();
  assert.equal(app.verdict, 'pending');
  const before = offs(world);
  await act(app.readBack(PRIORITY.CONFIRM, app.monotonic() + 5 * SECOND, { resend: true }));
  await act(new Promise((r) => app.timers.setTimeout(r, 500)));
  assert.equal(offs(world), before, 'nothing sent before the MAC is read again');
  app.stop();
});

test('I1: a presumed slot at another address than 0.1.2 read: its reads send nothing', async () => {
  const device = switchOf('r1');
  const world = fakeIpx();
  const store = memoryStore(legacyMemory({ ...V4_R1, host: '192.168.1.99' }));
  const { app, start, wait, cmd } = await setup({
    config: V4_R1,
    devices: [device],
    world,
    store,
  });
  await start();
  assert.equal(app.verdict, 'presumed');
  assert.equal(app.mayDrive(true), false);
  world.R[1] = 1;
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 0)).success, false);
  await wait(30 * SECOND);
  assert.equal(offs(world), 0);
  app.stop();
});

// --- I2: owner not known, /data writable -----------------------------------------------------

test('I2 (d9): owner not known, /data read only then writable: the Off goes in both, the rest waits for Attach', async () => {
  const device = switchOf('r1');
  const world = fakeIpx();
  const store = memoryStore();
  store.fail = true;
  const { app, gladys, start, wait, cmd } = await setup({
    config: V4_R1,
    devices: [device],
    world,
    store,
    fresh: true,
  });
  await start();
  assert.equal(app.storeLost, true);
  world.R[1] = 1;
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 0)).success, true);
  store.fail = false;
  await wait(10 * SECOND);
  assert.equal(app.storeLost, false);
  assert.match(message(gladys), /not known to belong to the IPX800 read/);
  world.R[1] = 1;
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 0)).success, true);
  assert.equal(offs(world), 2);
  const on = await cmd(device, F('relay', 'r1', 'switch'), 1);
  assert.match(on.error, /Rien ne dit/);
  // An Off held meanwhile is going to this IPX800 already: Attach keeps it.
  world.ignoreWrites = true;
  world.R[1] = 1;
  await cmd(device, F('relay', 'r1', 'switch'), 0);
  await gladys.fake.action('attach_devices', { ipx: '1' });
  const done = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(done.data.message.en, /Done/);
  assert.ok(app.guards.has('r1'), 'the Off held for this IPX800 stays held');
  app.stop();
});

// --- I3: Offs held across a new session -------------------------------------------------------

test('I3: /data not writable, an Off held, a new API key: the Off is still sent again', async () => {
  const device = switchOf('r1');
  const world = fakeIpx();
  const store = memoryStore();
  const config = { ...V4_R1, poll_interval: 5 };
  const { app, gladys, start, wait, cmd } = await setup({
    config,
    devices: [device],
    world,
    store,
  });
  await start(config);
  store.fail = true;
  world.R[1] = 1;
  world.ignoreWrites = true;
  await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.equal(store.data.guards.length, 0, 'never written');
  world.key = 'new-key';
  await gladys.fake.configUpdated({ ...config, api_key: 'new-key' });
  const before = offs(world);
  await wait(20 * SECOND);
  assert.ok(offs(world) - before >= 1, `${offs(world) - before} sent again`);
  assert.ok(app.guards.has('r1'));
  // Another controller (another address): not carried.
  await gladys.fake.configUpdated({ ...config, api_key: 'new-key', host: '192.168.1.77' });
  assert.equal(app.guards.has('r1'), false);
  app.stop();
});

test('I3: the Offs held are never carried to another address (where the owner is not known either)', async () => {
  const device = switchOf('r1');
  const wa = fakeIpx();
  const wb = fakeIpx();
  const world = {
    set clock(clock) {
      wa.clock = clock;
      wb.clock = clock;
    },
    transport: (o, h) => (o.hostname === '192.168.1.77' ? wb : wa).transport(o, h),
  };
  const store = memoryStore(boundMemory(V4_R1));
  store.unreadable = true;
  const config = { ...V4_R1, poll_interval: 5 };
  const { app, gladys, start, wait, cmd } = await setup({
    config,
    devices: [device],
    world,
    store,
  });
  await start(config);
  assert.equal(app.verdict, 'unbound');
  wa.R[1] = 1;
  wa.ignoreWrites = true;
  await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.ok(app.guards.has('r1'));
  wb.R[1] = 1;
  await gladys.fake.configUpdated({ ...config, host: '192.168.1.77' });
  await wait(20 * SECOND);
  assert.equal(offs(wb), 0, 'the Off held for the old address never reaches the new one');
  app.stop();
});

// --- I4: two slots with the same address --------------------------------------------------------

test('I4: slotConfigs keeps the slot verified at the address, whichever its number', () => {
  const raw = {
    version: 'v5',
    host: '192.168.1.51',
    api_key: KEY,
    version_2: 'v5',
    host_2: '192.168.1.51',
    api_key_2: KEY,
  };
  const key = normalizeConfig({ version: 'v5', host: '192.168.1.51' }).key;
  assert.equal(slotConfigs(raw).get(2).duplicate_of, 1, 'none verified: the first');
  const verified = slotConfigs(raw, 3, new Map([[2, key]]));
  assert.equal(verified.get(1).duplicate_of, 2);
  assert.equal(verified.get(1).duplicate_verified, true);
  assert.equal(verified.get(2).duplicate_of, undefined);
  const elsewhere = slotConfigs(raw, 3, new Map([[1, 'f'.repeat(32)]]));
  assert.equal(elsewhere.get(2).duplicate_of, 1, 'verified elsewhere is not verified here');
  // m2 (N16): the slot it duplicates is part of the session.
  const a = normalizeConfig(verified.get(1));
  const b = normalizeConfig(slotConfigs(raw).get(1));
  assert.notEqual(sessionKey(a), sessionKey(b));
});

const A_HOST = '192.168.1.50';
const B_HOST = '192.168.1.51';
const B_MAC = '00:04:a3:5e:00:0b';

async function hubOf({ config, devices = [] }) {
  const clock = testClock({ start: START });
  const wa = fakeIpx({ version: 'v5' });
  const wb = fakeIpx({ version: 'v5' });
  wb.mac = B_MAC;
  wa.clock = clock;
  wb.clock = clock;
  const gladys = createFakeGladys({ selector: 'ipx', config, devices });
  await gladys.connect();
  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  const stores = new Map([1, 2, 3].map((s) => [s, memoryStore()]));
  const hub = new IpxHub({
    gladys,
    logger: { info: log, warn: log, error: log, debug: log },
    transport: (o, h) => (o.hostname === B_HOST ? wb : wa).transport(o, h),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    storeOf: (slot) => stores.get(slot),
    random: () => SALT,
  });
  registerHandlers(gladys, hub);
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle();
  };
  const act = async (promise) => {
    let done = false;
    const out = promise.then(
      (v) => ((done = true), v),
      (e) => ((done = true), { error: e }),
    );
    for (let t = 0; !done && t < 30_000; t += 10) {
      await clock.advance(10);
      await settle(3);
    }
    return out;
  };
  const create = async (id) => {
    const d = gladys.fake.discoveredDevices.find((x) => x.external_id === `ext:ipx:${id}`);
    await gladys.fake.deviceCreated(d);
    return gladys.devices.find((x) => x.external_id === d.external_id);
  };
  const set = (device, value) =>
    act(
      gladys.fake.setValue(
        device,
        device.features.find((f) => f.external_id.endsWith(':switch')),
        value,
      ),
    );
  return { hub, gladys, wa, wb, stores, wait, act, create, set };
}

const TWO = {
  version: 'v5',
  host: A_HOST,
  api_key: KEY,
  relays: 'R1',
  version_2: 'v5',
  host_2: B_HOST,
  api_key_2: KEY,
  relays_2: 'R1',
};

test('I4: a typo puts the address of slot 2 in slot 1: slot 2 keeps it, slot 1 is stopped and told', async () => {
  const { hub, gladys, wa, wb, wait, act, create, set } = await hubOf({ config: TWO });
  await act(hub.onConnected(() => gladys.getConfig()));
  await wait(1000);
  const r1 = await create('relay:r1');
  const b1 = await create('ipx2:relay:r1');
  await act(gladys.fake.configUpdated({ ...TWO, host: B_HOST }));
  await wait(11 * SECOND);
  const status = gladys.fake.connectionStatus.message.en;
  assert.match(
    status,
    /IPX800 #1: Same address as IPX800 #2, whose devices belong to the IPX800 at that address: IPX800 #1 is not read.*Correct the address of IPX800 #1/,
  );
  assert.match(status, /IPX800 #2: Connected to the IPX800 V5/);
  wb.io.set(110, true);
  const offB = await set(b1, 0);
  assert.equal(offB.success, true, offB.error);
  assert.equal(wb.io.get(110), false, 'the Off of slot 2 reached its own IPX800');
  const offA = await set(r1, 0);
  assert.match(offA.error, /L’IPX800 n°1 a la même adresse que l’IPX800 n°2 et n’est pas lu/);
  assert.doesNotMatch(offA.error, /manque/);
  assert.equal(wa.writes().length, 0);
  assert.equal(wb.peak, 1, 'one request at a time to B');
  hub.stop();
});

test('m2 (N16): a slot no longer sharing its address starts reading (its session changed)', async () => {
  const same = { ...TWO, host_2: A_HOST };
  const { hub, gladys, wb, wait, act } = await hubOf({ config: same });
  await act(hub.onConnected(() => gladys.getConfig()));
  await wait(1000);
  assert.match(gladys.fake.connectionStatus.message.en, /IPX800 #2: Same address as IPX800 #1/);
  // Slot 1 moves to B: slot 2, unchanged, is no longer a duplicate and reads A.
  await act(gladys.fake.configUpdated({ ...same, host: B_HOST }));
  await wait(11 * SECOND);
  const status = gladys.fake.connectionStatus.message.en;
  assert.match(status, /IPX800 #2: Connected to the IPX800 V5/);
  assert.ok(wb.requests.length > 0);
  hub.stop();
});

test('I4: the configurations saved reach the slots in their order (an owner read in between)', async () => {
  const { hub, gladys, stores, wait, act } = await hubOf({ config: TWO });
  // Slot 2's /data unreadable: its owner is read again (slowly) when its address is shared.
  stores.get(2).unreadable = true;
  await act(hub.onConnected(() => gladys.getConfig()));
  await wait(1000);
  stores.get(2).load = () =>
    new Promise((resolve) => hub.controllers.get(2).timers.setTimeout(() => resolve(null), 200));
  const shared = hub.configUpdated({ ...TWO, host_2: A_HOST });
  const last = hub.configUpdated({ ...TWO, host: '192.168.1.52' });
  await act(Promise.all([shared, last]));
  assert.equal(hub.controllers.get(1).config.host, '192.168.1.52', 'the last one saved wins');
  assert.equal(hub.controllers.get(2).config.host, B_HOST);
  hub.stop();
});

// --- m2: guards without a test in r4 --------------------------------------------------------------

test('m2 (N8): Offs kept by 0.1.2 for devices of another model are dropped at start, from /data too', async () => {
  const devices = [switchOf('r1'), created('pilot-wire', 'x4fp7-1')];
  const store = memoryStore({
    ...legacyMemory(V4_R1),
    guards: [{ code: 'r1', kind: 'relay', value: 0 }],
  });
  const { app, start } = await setup({ config: V4_R1, devices, store });
  await start();
  assert.equal(app.verdict, 'unfit');
  assert.equal(app.guards.size, 0);
  assert.deepEqual(store.data.guards, []);
  app.stop();
});

test('m2 (N5): a 0.1.2 file without any device left: the IPX800 read becomes the owner', async () => {
  const world = fakeIpx();
  const store = memoryStore(legacyMemory(V4_R1));
  const { app, gladys, start } = await setup({ config: V4_R1, world, store });
  await start();
  assert.equal(app.verdict, 'same');
  assert.equal(store.data.owner.legacy, undefined);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(discovered(gladys).includes('ext:ipx:relay:r1'));
  app.stop();
});

test('m2 (N13): Attach while /data cannot be written: refused at the first click, nothing changed', async () => {
  const device = switchOf('r1');
  const world = fakeIpx();
  const store = memoryStore(legacyMemory(V4_R1));
  const { app, gladys, start, wait } = await setup({
    config: V4_R1,
    devices: [device],
    world,
    store,
  });
  await start();
  assert.equal(app.verdict, 'presumed');
  store.fail = true;
  await wait(10 * SECOND);
  assert.equal(app.saveFailed, true);
  const first = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(first.data.message.en, /Not attached: the state cannot be written to \/data/);
  const second = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(second.data.message.en, /Not attached/);
  assert.equal(app.verdict, 'presumed');
  assert.equal(app.memory.owner.legacy, true);
  // Written again: Attach in two clicks.
  store.fail = false;
  await wait(10 * SECOND);
  await gladys.fake.action('attach_devices', { ipx: '1' });
  const done = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(done.data.message.en, /Done/);
  assert.equal(store.data.owner.legacy, undefined);
  app.stop();
});

test('m2: Attach whose save fails at the second click: not done, said, the owner unchanged', async () => {
  const device = switchOf('r1');
  const store = memoryStore(legacyMemory(V4_R1));
  const { app, gladys, start } = await setup({ config: V4_R1, devices: [device], store });
  await start();
  await gladys.fake.action('attach_devices', { ipx: '1' });
  store.fail = true;
  const second = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(second.data.message.en, /Not attached: the state cannot be written to \/data/);
  assert.equal(app.verdict, 'presumed');
  assert.equal(app.memory.owner.legacy, true);
  app.stop();
});

test('m2 (N14): Attach while the MAC of a V5 is to be read again: refused, said', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const { app, gladys, start } = await setup({
    version: 'v5',
    config: V5_R1,
    devices: [device],
    world,
  });
  await start();
  assert.equal(app.verdict, 'same');
  const owner = structuredClone(app.memory.owner);
  // The state a failed round leaves (recheck), here with the last round still standing (a
  // belt: a failed round also marks the IPX800 unread, which Attach refuses first).
  app.recheck();
  assert.equal(app.verdict, 'pending');
  const answer = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.equal(answer.data.message.en, T.attach.unreadable.en);
  assert.deepEqual(app.memory.owner, owner);
  app.stop();
});
