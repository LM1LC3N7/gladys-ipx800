// -----------------------------------------------------------------------------
// Which IPX800 the devices belong to (the owner in /data): a device made for
// one IPX800 never drives another one, an Off kept for the old one neither;
// the model typed wrong is said; the Discover list shows only the IPX800
// really read. The app against the SDK's fake Gladys, fake IPX800 V4 and V5
// and the virtual clock (its reads always move).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controllerKey, normalizeConfig } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { KEY, MAC, fakeIpx } from './helpers/fakeIpx.js';
import { CONFIG, F, SECOND, boundMemory, created, setup } from './helpers/app.js';

const V4_HOST = '192.168.1.60';
const message = (gladys, lang = 'en') => gladys.fake.connectionStatus?.message?.[lang] ?? '';
const discovered = (gladys) => (gladys.fake.discoveredDevices ?? []).map((d) => d.external_id);
const switchOf = (code) => created('relay', code, { relayKind: 'switch' });
const V5_RELAYS = { ...CONFIG.v5, relays: 'R1, R2' };
const V4_THERE = { version: 'v4', host: V4_HOST, api_key: KEY, relays: 'R1, R2' };

/** A V5 at ADDRESS and a V4 at V4_HOST behind one transport (two boxes of one house). */
function twoIpx() {
  const w5 = fakeIpx({ version: 'v5' });
  const w4 = fakeIpx({ version: 'v4' });
  const world = {
    set clock(clock) {
      w5.clock = clock;
      w4.clock = clock;
    },
    transport: (options, hooks) =>
      (options.hostname === V4_HOST ? w4 : w5).transport(options, hooks),
  };
  return { world, w5, w4 };
}

/** A /data written by 0.1.2 (no `format`): the controller key it read last. */
const legacyMemory = (raw, extra = {}) => ({
  lastAttemptAt: null,
  key: normalizeConfig(raw).key,
  pause: null,
  refused: null,
  layout: {},
  guards: [],
  ...extra,
});

// --- A: never another IPX800 -----------------------------------------------------------

test('cce66: V5 devices, then the address and key of a V4 typed: nothing reaches the V4, not even an Off', async () => {
  const devices = [switchOf('r1'), switchOf('r2'), created('pilot-wire', 'x4fp7-1')];
  const { world, w5, w4 } = twoIpx();
  const { app, gladys, start, wait, cmd } = await setup({
    version: 'v5',
    config: V5_RELAYS,
    devices,
    world,
  });
  await start();
  assert.equal((await cmd(devices[0], F('relay', 'r1', 'switch'), 1)).success, true);
  assert.deepEqual(
    w5.writes().map((r) => r.path),
    ['/api/core/io/100?ApiKey=S3cretKey-42'],
  );
  w4.R[2] = 1;
  await gladys.fake.configUpdated(V4_THERE);
  // Before the V4 is even read: the owner is the V5's MAC, a V4 has none.
  const off = await cmd(devices[0], F('relay', 'r1', 'switch'), 0);
  assert.equal(off.success, false);
  assert.match(off.error, /n’est pas celui pour lequel cet appareil a été créé/);
  await wait(10 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys), /The IPX800 V4 at this address is not the one the devices/);
  assert.match(message(gladys), /"Attach the devices" twice/);
  assert.deepEqual(discovered(gladys), [], 'nothing of the V4 under the V5 ids');
  for (const value of [0, 1]) {
    const ack = await cmd(devices[1], F('relay', 'r2', 'switch'), value);
    assert.equal(ack.success, false);
  }
  assert.equal(w4.writes().length, 0, 'not one write to the V4');
  await app.flush();
  assert.notEqual(
    gladys.fake.lastState(F('relay', 'r2', 'switch')),
    1,
    'no value of the V4 published onto the V5 devices',
  );
  app.stop();
});

test('a V5 swapped at the same address: the Off kept for the old one is never sent to it', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = memoryStore();
  const config = { ...CONFIG.v5, relays: 'R1' };
  const first = await setup({ version: 'v5', config, devices: [device], world, store });
  await first.start();
  world.latency = (r) => (r.method === 'PUT' ? 6 * SECOND : 20);
  const ack = await first.cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.match(ack.error, /sans confirmation/);
  await first.app.shutdown();
  assert.deepEqual(
    store.data.guards.map((g) => g.code),
    ['r1'],
  );
  world.latency = 20;
  world.mac = '00:04:a3:5e:00:99';
  const before = world.writes().length;
  const again = await setup({
    version: 'v5',
    config,
    devices: [device],
    world,
    store,
    clock: first.clock,
  });
  await again.start();
  assert.equal(world.writes().length, before, 'the Off kept never left for the new IPX800');
  assert.deepEqual(store.data.guards, []);
  assert.match(message(again.gladys), /IPX800 V5 \(MAC …5e:00:99\) at this address is not the one/);
  const on = await again.cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.match(on.error, /n’est pas celui/);
  assert.equal(world.writes().length, before);
  again.app.stop();
});

test('the same V5 after a restart: its MAC first, then the Off kept goes', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = memoryStore();
  const config = { ...CONFIG.v5, relays: 'R1' };
  const first = await setup({ version: 'v5', config, devices: [device], world, store });
  await first.start();
  world.latency = (r) => (r.method === 'PUT' ? 6 * SECOND : 20);
  await first.cmd(device, F('relay', 'r1', 'switch'), 0);
  await first.app.shutdown();
  world.latency = 20;
  const from = world.requests.length;
  const again = await setup({
    version: 'v5',
    config,
    devices: [device],
    world,
    store,
    clock: first.clock,
  });
  await again.start();
  const paths = world.requests.slice(from).map((r) => `${r.method} ${r.path.split('?')[0]}`);
  assert.deepEqual(paths.slice(0, 2), ['GET /api/system/info', 'PUT /api/core/io/100']);
  again.app.stop();
});

test('a round finding another MAC mid-session: the Offs kept are dropped, nothing sent any more', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const { app, store, start, wait, cmd, gladys } = await setup({
    version: 'v5',
    config: { ...CONFIG.v5, relays: 'R1' },
    devices: [device],
    world,
  });
  await start();
  world.ignoreWrites = true;
  world.io.set(110, true);
  await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.equal(store.data.guards.length, 1, 'contradicted: kept');
  // Past the read backs of the command (5 s, 20 s): the next round finds the other one.
  await wait(21 * SECOND);
  world.mac = '00:04:a3:5e:00:42';
  const writes = world.writes().length;
  await wait(30 * SECOND);
  assert.equal(world.writes().length, writes, 'no resend to the other IPX800');
  assert.deepEqual(store.data.guards, []);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 0)).success, false);
  app.stop();
});

test('MAC unreadable: an Off still goes, a switch-on is refused; at a new address nothing goes', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5', mac: undefined });
  const { app, gladys, start, wait, cmd } = await setup({
    version: 'v5',
    config: { ...CONFIG.v5, relays: 'R1' },
    devices: [device],
    world,
  });
  await start();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys), /MAC address could not be read this time/);
  const on = await cmd(device, F('relay', 'r1', 'switch'), 1);
  assert.match(on.error, /MAC de l’IPX800 n’est pas encore lue/);
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 0)).success, true);
  assert.equal(world.writes().length, 1);
  await gladys.fake.configUpdated({ ...CONFIG.v5, host: '192.168.1.77', relays: 'R1' });
  await wait(10 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys), /At this new address, its MAC address could not be read/);
  assert.deepEqual(discovered(gladys), []);
  const off = await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.match(off.error, /nouvelle adresse/);
  assert.equal(world.writes().length, 1);
  app.stop();
});

test('a fresh V5 without system/info is known by its address, then by its MAC, never back', async () => {
  const world = fakeIpx({ version: 'v5', mac: undefined });
  const { app, store, start, wait, gladys } = await setup({ version: 'v5', world, fresh: true });
  await start();
  const key = normalizeConfig(CONFIG.v5).key;
  assert.deepEqual(store.data.owner, { kind: 'address', id: key, at: key });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  world.mac = MAC;
  await wait(10 * SECOND);
  assert.equal(store.data.owner.kind, 'mac');
  assert.doesNotMatch(JSON.stringify(store.data), /00:04:a3/, 'never the MAC itself');
  world.mac = undefined;
  await wait(10 * SECOND);
  assert.equal(store.data.owner.kind, 'mac', 'no downgrade');
  assert.equal(app.verdict, 'unverified');
  app.stop();
});

// --- Attach --------------------------------------------------------------------------

test('a V4 moved to another address: refused until "Attach the devices" is clicked twice', async () => {
  const device = switchOf('r1');
  const { app, gladys, store, start, wait, cmd, world } = await setup({
    config: { ...CONFIG.v4, relays: 'R1' },
    devices: [device],
  });
  await start();
  const moved = { ...CONFIG.v4, host: '192.168.1.61', relays: 'R1' };
  await gladys.fake.configUpdated(moved);
  await wait(10 * SECOND);
  assert.match(message(gladys), /The IPX800 V4 at this address is not the one/);
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 1)).success, false);
  const first = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(first.data.message.en, /Click again within a minute to attach the 1 device\(s\)/);
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 1)).success, false);
  assert.equal(world.writes().length, 0);
  await wait(TIMINGS.attachConfirm + SECOND);
  const late = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(late.data.message.en, /Click again/, 'a second click after a minute asks again');
  const done = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(done.data.message.fr, /C’est fait : les 1 appareil\(s\) de l’IPX800 n°1/);
  assert.equal(store.data.owner.id, controllerKey('v4', '192.168.1.61', 80));
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 1)).success, true);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(discovered(gladys).includes('ext:ipx:relay:r1'));
  const again = await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.match(again.data.message.en, /already belong/);
  app.stop();
});

test('Attach: nothing read yet, or the IPX800 not answering: refused', async () => {
  const world = fakeIpx();
  world.refuseConnect = 99;
  const { app, start } = await setup({ world, devices: [switchOf('r1')] });
  assert.match((await app.attach()).en, /No IPX800 read right now/);
  await start();
  assert.match((await app.attach()).en, /No IPX800 read right now/);
  app.stop();
});

test('a slot whose devices are all gone takes the IPX800 read as its owner', async () => {
  const world = fakeIpx({ version: 'v5', mac: '00:04:a3:5e:00:55' });
  const { app, gladys, store, start } = await setup({ version: 'v5', world });
  await start();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(discovered(gladys).length > 0);
  assert.notDeepEqual(store.data.owner, boundMemory(CONFIG.v5).owner);
  app.stop();
});

// --- 0.1.2 -----------------------------------------------------------------------------

test('0.1.2 /data of this V5: an Off before the first read goes, then its MAC is the owner', async () => {
  const devices = [switchOf('r1'), created('pilot-wire', 'x4fp7-1')];
  const store = memoryStore(
    legacyMemory(V5_RELAYS, { layout: { r1: { kind: 'relay', state: 110, command: 100 } } }),
  );
  const { app, cmd, world, wait } = await setup({
    version: 'v5',
    config: V5_RELAYS,
    devices,
    store,
  });
  world.latency = 300;
  const starting = app.connected(V5_RELAYS);
  await wait(50);
  const off = await cmd(devices[0], F('relay', 'r1', 'switch'), 0);
  assert.equal(off.success, true, off.error);
  await starting;
  // The round the Off cut comes back at the interval (8 requests of 300 ms).
  await wait(15 * SECOND);
  assert.equal(store.data.owner.kind, 'mac');
  assert.equal(store.data.owner.legacy, undefined);
  assert.equal(store.data.format, 2);
  assert.equal((await cmd(devices[0], F('relay', 'r1', 'switch'), 1)).success, true);
  app.stop();
});

test('0.1.2 /data of a V4 config, devices made on a V5 (an X-4FP zone): nothing sent, said', async () => {
  const devices = [switchOf('r1'), switchOf('r2'), created('pilot-wire', 'x4fp7-1')];
  const { world, w4 } = twoIpx();
  const { app, gladys, start, cmd } = await setup({
    config: V4_THERE,
    devices,
    world,
    store: memoryStore(legacyMemory(V4_THERE)),
  });
  await start();
  assert.match(message(gladys), /created with an earlier version for another model/);
  assert.match(message(gladys, 'fr'), /version précédente pour un autre modèle/);
  assert.deepEqual(discovered(gladys), []);
  for (const value of [0, 1]) {
    assert.equal((await cmd(devices[0], F('relay', 'r1', 'switch'), value)).success, false);
  }
  assert.equal(w4.writes().length, 0);
  app.stop();
});

test('0.1.2 /data of a V4 config, relays only: they stay with that V4 (nothing tells them apart)', async () => {
  const devices = [switchOf('r1')];
  const { world, w4 } = twoIpx();
  const { app, store, start, cmd } = await setup({
    config: V4_THERE,
    devices,
    world,
    store: memoryStore(legacyMemory(V4_THERE)),
  });
  await start();
  assert.equal((await cmd(devices[0], F('relay', 'r1', 'switch'), 1)).success, true);
  assert.equal(w4.writes().length, 1);
  assert.equal(store.data.owner.kind, 'address');
  app.stop();
});

// --- /data unreadable ------------------------------------------------------------------

test('/data unreadable: no owner set over it, an Off goes, a switch-on waits for it', async () => {
  const device = switchOf('r1');
  const store = memoryStore();
  store.unreadable = true;
  const config = { ...CONFIG.v5, relays: 'R1' };
  const { app, gladys, start, wait, cmd, world } = await setup({
    version: 'v5',
    config,
    devices: [device],
    store,
    fresh: true,
  });
  await start();
  assert.match(message(gladys), /state in \/data cannot be read/);
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 1)).success, false);
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 0)).success, true);
  assert.equal(world.writes().length, 1);
  assert.equal(store.data, null, 'nothing written over it');
  store.unreadable = false;
  store.data = boundMemory(config);
  await wait(10 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 1)).success, true);
  app.stop();
});

// --- C: the other model ------------------------------------------------------------------

test('V5 typed on a V4: said in the status and by the test button, no key refused', async () => {
  const { app, gladys, store, start, wait } = await setup({
    version: 'v5',
    world: fakeIpx({ version: 'v4' }),
    fresh: true,
  });
  await start();
  assert.match(message(gladys), /This IPX800 is a V4, but "Model" says V5: choose V4/);
  assert.match(message(gladys, 'fr'), /Cet IPX800 est une V4, mais « Modèle » indique V5/);
  assert.equal(store.data.refused, null);
  assert.deepEqual(discovered(gladys), []);
  await wait(30 * SECOND);
  const answer = await app.testConnection();
  assert.match(answer.en, /is a V4/);
  app.stop();
});

test('V4 typed on a V5 (which answers 401 to the V4 path): said, no key refused', async () => {
  const { app, gladys, store, start } = await setup({
    world: fakeIpx({ version: 'v5' }),
    fresh: true,
  });
  await start();
  assert.match(message(gladys), /This IPX800 is a V5, but "Model" says V4: choose V5/);
  assert.equal(store.data.refused, null);
  app.stop();
});

test('a wrong key on the right model is still a refused key (the other API does not answer)', async () => {
  const { app, gladys, store, start } = await setup({
    config: { ...CONFIG.v4, api_key: 'wrong' },
    fresh: true,
  });
  await start();
  assert.match(message(gladys), /refused the API key/);
  assert.ok(store.data.refused);
  app.stop();
});

// --- D, E: the Discover list -------------------------------------------------------------

test('Discover: only what was read; emptied by a failure, a refused key, a bogus address', async () => {
  const world = fakeIpx();
  world.latency = 2 * SECOND;
  const { app, gladys, start, wait } = await setup({ world });
  const starting = app.connected(CONFIG.v4);
  await wait(500);
  assert.deepEqual(discovered(gladys), [], 'the V4 targets of the configuration: not read yet');
  await starting;
  await start();
  await wait(2 * SECOND);
  assert.ok(discovered(gladys).includes('ext:ipx:relay:r1'));
  world.latency = 20;
  world.refuseConnect = 99;
  await wait(10 * SECOND);
  assert.deepEqual(discovered(gladys), [], 'unreachable');
  await gladys.fake.scanRequest();
  assert.deepEqual(discovered(gladys), []);
  world.refuseConnect = 0;
  await wait(60 * SECOND);
  assert.ok(discovered(gladys).length > 0);
  await gladys.fake.configUpdated({ ...CONFIG.v4, host: '' });
  assert.deepEqual(discovered(gladys), [], 'no address: the old list goes');
  app.stop();
});

test('E: a device deleted: the Discover list again at once, without the switch of the deleted one', async () => {
  const device = switchOf('r2');
  const { app, gladys, start } = await setup({
    config: { ...CONFIG.v4, relays: 'R1, R2' },
    devices: [device],
  });
  await start();
  await gladys.fake.configUpdated({ ...CONFIG.v4, relays: 'R1' });
  const before = gladys.fake.discoveredDevices.find((d) => d.external_id === 'ext:ipx:relay:r2');
  assert.deepEqual(
    before.features.map((f) => f.external_id.split(':').pop()),
    ['readonly', 'switch'],
  );
  await gladys.fake.deviceDeleted(gladys.devices.find((d) => d.external_id === device.external_id));
  const after = gladys.fake.discoveredDevices.find((d) => d.external_id === 'ext:ipx:relay:r2');
  assert.deepEqual(
    after.features.map((f) => f.external_id.split(':').pop()),
    ['readonly'],
  );
  app.stop();
});

// --- At start, while the MAC is read ----------------------------------------------------

test('at start a click waits for the MAC: a switch-on then goes; an Off waits 1.5 s at most', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const store = memoryStore();
  const config = { ...CONFIG.v5, relays: 'R1' };
  const first = await setup({ version: 'v5', config, devices: [device], world, store });
  await first.start();
  first.app.stop();
  world.latency = (r) => (/system\/info/.test(r.path) ? 800 : 20);
  const again = await setup({
    version: 'v5',
    config,
    devices: [device],
    world,
    store,
    clock: first.clock,
  });
  const starting = again.app.connected(config);
  await again.wait(10);
  const on = await again.cmd(device, F('relay', 'r1', 'switch'), 1);
  assert.equal(on.success, true, on.error);
  await starting;
  again.app.stop();

  world.latency = (r) => (/system\/info/.test(r.path) ? 4 * SECOND : 20);
  const third = await setup({
    version: 'v5',
    config,
    devices: [device],
    world,
    store,
    clock: first.clock,
  });
  const restarting = third.app.connected(config);
  await third.wait(10);
  const clicked = first.clock.monotonic();
  const ack = await third.cmd(device, F('relay', 'r1', 'switch'), 0);
  const put = world.writes().at(-1);
  assert.equal(put.body.on, false, 'the Off left (same address as last checked)');
  const waited = put.at - clicked;
  assert.ok(
    waited >= TIMINGS.identityWait - 50 && waited <= TIMINGS.identityWait + 200,
    `${waited} ms`,
  );
  assert.ok(ack.success || /sans confirmation/.test(ack.error), ack.error);
  await restarting;
  third.app.stop();
});

test('after a failed round, an Off reads the MAC first: another V5 there gets nothing', async () => {
  const device = switchOf('r1');
  const world = fakeIpx({ version: 'v5' });
  const { app, start, wait, cmd } = await setup({
    version: 'v5',
    config: { ...CONFIG.v5, relays: 'R1' },
    devices: [device],
    world,
  });
  await start();
  world.refuseConnect = 99;
  await wait(10 * SECOND);
  assert.equal(app.verdict, 'pending', 'no answer: to be checked again');
  // Replaced meanwhile, before the next round (the pause after a failure).
  world.refuseConnect = 0;
  world.mac = '00:04:a3:5e:00:66';
  const off = await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.match(off.error, /n’est pas celui/);
  assert.equal(world.writes().length, 0);
  assert.deepEqual(
    world.requests.slice(-1).map((r) => r.path.split('?')[0]),
    ['/api/system/info'],
  );
  // The same one back: the Off goes after its MAC.
  world.mac = MAC;
  app.verdict = 'same';
  app.recheck();
  const again = await cmd(device, F('relay', 'r1', 'switch'), 0);
  assert.equal(again.success, true, again.error);
  assert.equal(world.writes().length, 1);
  app.stop();
});

test('/data lost (a fresh file) with devices there: not bound to whatever answers, Attach asked', async () => {
  const device = switchOf('r1');
  const { app, gladys, store, start, cmd, world } = await setup({
    config: { ...CONFIG.v4, relays: 'R1' },
    devices: [device],
    fresh: true,
  });
  await start();
  assert.equal(store.data.owner, null);
  assert.match(message(gladys), /not known to belong to the IPX800 read/);
  for (const value of [0, 1]) {
    assert.equal((await cmd(device, F('relay', 'r1', 'switch'), value)).success, false);
  }
  assert.equal(world.writes().length, 0);
  await gladys.fake.action('attach_devices', { ipx: '1' });
  await gladys.fake.action('attach_devices', { ipx: '1' });
  assert.equal((await cmd(device, F('relay', 'r1', 'switch'), 1)).success, true);
  app.stop();
});

test('a command waiting in the queue is refused right before it leaves when another IPX800 was found', async () => {
  const r1 = switchOf('r1');
  const r2 = switchOf('r2');
  const world = fakeIpx();
  const { app, start, act, gladys } = await setup({
    config: { ...CONFIG.v4, relays: 'R1, R2' },
    devices: [r1, r2],
    world,
  });
  await start();
  world.latency = (r) => (/SetR/.test(r.path) ? 1000 : 20);
  const first = gladys.fake.setValue(r1, { external_id: F('relay', 'r1', 'switch') }, 1);
  const second = gladys.fake.setValue(r2, { external_id: F('relay', 'r2', 'switch') }, 1);
  const flip = (async () => {
    while (world.writes().length === 0) await new Promise((r) => setImmediate(r));
    // A round finds another IPX800 while the first write is in flight.
    app.verdict = 'different';
  })();
  const [a, b] = await act(Promise.all([first, second, flip]));
  assert.equal(a.success !== undefined, true);
  assert.match(b.error, /n’est pas celui/);
  assert.equal(world.writes().length, 1, 'the second never left');
  app.stop();
});
