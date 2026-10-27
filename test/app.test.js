// -----------------------------------------------------------------------------
// End to end: the app against the SDK's fake Gladys, a fake IPX800 (V4 and
// V5) and a virtual clock whose reads always move.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILOT, TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { KEY, fakeIpx, setV5Mode, v5Mode } from './helpers/fakeIpx.js';
import { ADDRESS, CONFIG, F, SECOND, created, settle, setup } from './helpers/app.js';

const rounds = (world, version) =>
  world.requests.filter((r) =>
    version === 'v4' ? /Get=all/.test(r.path) : /system\/ipx/.test(r.path),
  );
const message = (gladys, lang = 'en') => gladys.fake.connectionStatus?.message?.[lang] ?? '';

const v4Relays = (relays = 'R1, R2:light, R3, R4, R5') => ({ ...CONFIG.v4, relays });

// --- Reads ----------------------------------------------------------------------

test('V4 start: one Get=all at once, the targets discovered, connected; nothing secret in /data', async () => {
  const { app, gladys, start, store, world } = await setup({
    config: { ...CONFIG.v4, v4_extensions: 'R9-R16, FP1-FP4, THL1' },
  });
  await start();
  assert.equal(rounds(world, 'v4').length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    message(gladys),
    /IPX800 V4: 16 relay\(s\), 8 input\(s\), 4 pilot-wire zone\(s\), 1 X-THL/,
  );
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.ok(ids.includes('ext:ipx:relay:r16'));
  assert.ok(ids.includes('ext:ipx:pilot-wire:fp4'));
  assert.ok(!ids.includes('ext:ipx:relay:r17'));
  const relay = gladys.fake.discoveredDevices.find((d) => d.external_id === 'ext:ipx:relay:r1');
  assert.equal(relay.features.length, 1);
  assert.equal(relay.features[0].external_id, F('relay', 'r1', 'readonly'));
  assert.equal(relay.features[0].read_only, true, 'a relay not declared is read only');
  const json = JSON.stringify(store.data);
  assert.doesNotMatch(json, new RegExp(KEY));
  assert.doesNotMatch(json, /192\.168/);
  assert.equal(gladys.fake.states.length, 0, 'no state before a device is created');
  app.stop();
});

test('V5 start: layout and values, extension names, THL published, the ids kept in /data', async () => {
  const devices = [created('thl', 'xthl9'), created('pilot-wire', 'x4fp7-1')];
  const { app, gladys, start, store, world } = await setup({ version: 'v5', devices });
  await start();
  assert.equal(world.peak, 1, 'one request at a time');
  assert.match(
    message(gladys),
    /IPX800 V5: 16 relay\(s\), 8 input\(s\), 4 pilot-wire zone\(s\), 1 X-THL/,
  );
  const names = gladys.fake.discoveredDevices.map((d) => d.name);
  assert.ok(names.includes('Garage relais 3 (X8R12-3)'), names.join(' | '));
  assert.ok(names.includes('Chauffage zone 2 (X4FP7-2)'));
  await app.flush();
  assert.equal(gladys.fake.lastState(F('thl', 'xthl9', 'temperature')), 21.5);
  assert.equal(gladys.fake.lastState(F('thl', 'xthl9', 'humidity')), 45);
  assert.equal(gladys.fake.lastState(F('pilot-wire', 'x4fp7-1', 'mode')), PILOT.OFF);
  assert.equal(store.data.layout['x4fp7-1'].io[PILOT.OFF], 312);
  assert.equal(store.data.layout['x8r12-3'].command, 202);
  app.stop();
});

test('pace: never two rounds within the interval, whatever asks; restart keeps the pace', async () => {
  const { app, gladys, start, wait, world, store, clock } = await setup();
  await start();
  assert.equal(rounds(world, 'v4').length, 1);
  await gladys.fake.scanRequest();
  await gladys.fake.configUpdated({ ...CONFIG.v4, language: 'en' });
  await app.testConnection();
  await app.connected(CONFIG.v4);
  await wait(5 * SECOND);
  assert.equal(rounds(world, 'v4').length, 1, 'nothing before the interval');
  await wait(5 * SECOND);
  assert.equal(rounds(world, 'v4').length, 2);
  await wait(60 * SECOND);
  assert.equal(rounds(world, 'v4').length, 8);
  app.stop();
  const again = await setup({ store, clock });
  await again.start();
  assert.equal(rounds(again.world, 'v4').length, 0, 'read less than an interval ago');
  await again.wait(10 * SECOND);
  assert.equal(rounds(again.world, 'v4').length, 1);
  again.app.stop();
});

test('a text, a missing key or an unknown mode is never published as 0', async () => {
  const devices = [created('thl', 'thl1'), created('pilot-wire', 'fp1'), created('input', 'd1')];
  const world = fakeIpx();
  world.THL[1] = { TEMP: 'n/a', HUM: 45, LUM: null };
  world.FP[1] = 'Inconnu';
  world.D[1] = '';
  const { app, gladys, start } = await setup({
    world,
    devices,
    config: { ...CONFIG.v4, v4_extensions: 'FP1, THL1' },
  });
  await start();
  await app.flush();
  const ids = gladys.fake.states.map((s) => s.device_feature_external_id);
  assert.ok(!ids.includes(F('thl', 'thl1', 'temperature')));
  assert.ok(!ids.includes(F('thl', 'thl1', 'luminosity')));
  assert.equal(gladys.fake.lastState(F('thl', 'thl1', 'humidity')), 45);
  assert.ok(!ids.includes(F('pilot-wire', 'fp1', 'mode')));
  assert.ok(!ids.includes(F('input', 'd1', 'state')));
  app.stop();
});

test('V5: a secondary list or core/ana failing (even 401) never stops the round', async () => {
  const world = fakeIpx({ version: 'v5' });
  const devices = [created('relay', 'r1'), created('thl', 'xthl9')];
  const { app, gladys, start, wait } = await setup({ version: 'v5', world, devices });
  await start();
  world.failPaths.set('ebx/x8r', 500);
  world.failPaths.set('core/ana', 401);
  world.io.set(110, true);
  await wait(10 * SECOND);
  await app.flush();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys), /not read this time.*X8R/);
  assert.equal(gladys.fake.lastState(F('relay', 'r1', 'readonly')), 1);
  assert.ok(app.model.has('x8r12-3'), 'the X-8R read before is kept');
  assert.equal(app.model.get('x8r12-3').value, undefined, 'its ids were not checked: no value');
  assert.equal(app.model.get('xthl9').value, undefined);
  app.stop();
});

test('a failed round pauses (kept in /data); a refused key stops the reads until it changes', async () => {
  const world = fakeIpx();
  const { app, gladys, start, wait, store } = await setup({ world });
  world.queue.push(new Error('boom'));
  world.queue.push({ status: 503, json: {} });
  await start();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await wait(10 * SECOND);
  assert.match(message(gladys), /asks to wait/);
  assert.equal(store.data.pause.code, 'busy');
  const before = world.requests.length;
  await wait(59 * SECOND);
  assert.ok(world.requests.length - before <= 1, 'a minute at least when the IPX asks to wait');
  app.stop();

  const refused = await setup({ config: { ...CONFIG.v4, api_key: 'wrong-key' } });
  await refused.start();
  assert.match(message(refused.gladys), /refused the API key/);
  assert.ok(refused.store.data.refused);
  assert.doesNotMatch(JSON.stringify(refused.store.data), /wrong-key/);
  const count = refused.world.requests.length;
  await refused.wait(10 * 60 * SECOND);
  assert.equal(refused.world.requests.length, count, 'no read by itself');
  await refused.gladys.fake.configUpdated(CONFIG.v4);
  await refused.wait(100);
  assert.equal(refused.gladys.fake.connectionStatus.connected, true, 'a new key reads again');
  refused.app.stop();
});

test('getConfig failing in "connected" is tried again with a status, then the integration starts', async () => {
  let calls = 0;
  const { app, gladys, wait, world } = await setup({
    getConfig: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Gladys busy');
      return CONFIG.v4;
    },
  });
  await app.onConnected(() => gladys.getConfig());
  assert.match(message(gladys), /could not be read from Gladys: new try in 5 s/);
  assert.equal(world.requests.length, 0);
  await wait(6 * SECOND);
  assert.equal(calls, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(rounds(world, 'v4').length, 1);
  // A reconnection to Gladys reads the configuration again, without a new round.
  await app.onConnected(() => gladys.getConfig());
  await wait(100);
  assert.equal(rounds(world, 'v4').length, 1);
  app.stop();
});

// --- Commands: relays -------------------------------------------------------------

test('a relay not declared is read only: refused, nothing sent, whatever its feature', async () => {
  const device = created('relay', 'r6', { relayKind: 'switch' });
  const { app, start, cmd, world } = await setup({ config: v4Relays(), devices: [device] });
  await start();
  const ack = await cmd(device, F('relay', 'r6', 'switch'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /lecture seule/);
  const off = await cmd(device, F('relay', 'r6', 'switch'), 0);
  assert.match(off.error, /lecture seule/, 'even a switch-off of an undeclared relay');
  assert.equal(world.writes().length, 0);
  app.stop();
});

test('a declared relay: on and off written, confirmed by a read back that left after the write', async () => {
  const device = created('relay', 'r2', { relayKind: 'light' });
  const { app, start, cmd, world, gladys } = await setup({
    config: v4Relays(),
    devices: [device],
  });
  await start();
  const on = await cmd(device, F('relay', 'r2', 'light'), 1);
  assert.equal(on.success, true, on.error);
  assert.equal(world.R[2], 1);
  const writes = world.writes();
  assert.match(writes[0].path, /SetR=02$/);
  const readBack = world.requests.at(-1);
  assert.match(readBack.path, /Get=all/);
  assert.ok(readBack.sentAt > writes[0].end, 'the read back left after the answer of the write');
  await app.flush();
  assert.equal(gladys.fake.lastState(F('relay', 'r2', 'light')), 1);
  const off = await cmd(device, F('relay', 'r2', 'light'), 0);
  assert.equal(off.success, true, off.error);
  assert.match(world.writes()[1].path, /ClearR=02$/);
  app.stop();
});

test('a read back equal to the state before is "not applied yet"; a lost answer is "sent, without confirmation"', async () => {
  const device = created('relay', 'r1', { relayKind: 'switch' });
  const world = fakeIpx();
  const { app, start, cmd } = await setup({ config: v4Relays(), devices: [device], world });
  await start();
  world.ignoreWrites = true;
  const ack = await cmd(device, F('relay', 'r1', 'switch'), 1);
  assert.match(ack.error, /lit éteint \(demandé : allumé\) : pas encore appliquée/);
  world.ignoreWrites = false;
  world.latency = (r) => (/SetR/.test(r.path) ? 10 * SECOND : 20);
  const lost = await cmd(device, F('relay', 'r1', 'switch'), 1);
  assert.match(lost.error, /Envoyée, sans confirmation/);
  world.latency = 20;
  world.refuseConnect = 1;
  const refused = await cmd(device, F('relay', 'r1', 'switch'), 1);
  assert.match(refused.error, /rien n’a été envoyé/, 'refused before leaving: not sent');
  app.stop();
});

test('a scene on 5 slow relays (700 ms a request) sets the 5', async () => {
  const devices = [1, 2, 3, 4, 5].map((n) => created('relay', `r${n}`, { relayKind: 'switch' }));
  const world = fakeIpx();
  const { app, start, act, gladys } = await setup({ config: v4Relays(), devices, world });
  await start();
  world.latency = 700;
  const acks = await act(
    Promise.all(devices.map((d) => gladys.fake.setValue(d, d.features[0], 1))),
  );
  for (const ack of acks) assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.R.slice(1, 6), [1, 1, 1, 1, 1]);
  assert.equal(world.peak, 1);
  app.stop();
});

// --- Commands: pilot wire ---------------------------------------------------------------

const v4Fp = (over = {}) => ({ ...CONFIG.v4, v4_extensions: 'FP1-FP4', ...over });

test('heating modes are off by default: refused, nothing sent; Off and Frost protection always go', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const { app, start, cmd } = await setup({ config: v4Fp(), devices: [device], world });
  await start();
  const comfort = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.COMFORT);
  assert.match(comfort.error, /désactivés/);
  assert.equal(world.writes().length, 0);
  const off = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  assert.equal(off.success, true, off.error);
  assert.match(world.writes()[0].path, /SetFP01=3$/);
  assert.equal(world.FP[1], 'Arret');
  const frost = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.FROST_PROTECTION);
  assert.equal(frost.success, true, frost.error);
  assert.equal(world.FP[1], 'Hors Gel');
  app.stop();
});

test('allowed heating modes are written once /data is; a /data that cannot be written refuses them, not the Off', async () => {
  const device = created('pilot-wire', 'fp2');
  const store = memoryStore();
  const { app, start, cmd, world } = await setup({
    config: v4Fp({ allow_heating_modes: true }),
    devices: [device],
    store,
  });
  await start();
  const eco = await cmd(device, F('pilot-wire', 'fp2', 'mode'), PILOT.ECO);
  assert.equal(eco.success, true, eco.error);
  assert.equal(world.FP[2], 'Eco');
  store.fail = true;
  const comfort = await cmd(device, F('pilot-wire', 'fp2', 'mode'), PILOT.COMFORT);
  assert.match(comfort.error, /\/data : rien n’a été envoyé/);
  assert.equal(world.FP[2], 'Eco');
  const off = await cmd(device, F('pilot-wire', 'fp2', 'mode'), PILOT.OFF);
  assert.equal(off.success, true, off.error);
  assert.equal(world.FP[2], 'Arret');
  app.stop();
});

test('the Off goes during a pause, with the queue full, and cuts a slow read', async () => {
  const device = created('pilot-wire', 'fp1');
  const relays = [1, 2, 3, 4, 5].map((n) => created('relay', `r${n}`, { relayKind: 'switch' }));
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const { app, start, cmd, act, gladys, wait, elapsed } = await setup({
    config: v4Fp({ relays: 'R1, R2, R3, R4, R5' }),
    devices: [device, ...relays],
    world,
  });
  await start();
  // A slow read in flight (4 s): the Off cuts it, leaves at once, the read is no failure.
  world.latency = (r) => (/Get=all/.test(r.path) && !world.fast ? 4 * SECOND : 20);
  await wait(10 * SECOND);
  assert.equal(world.inFlight, 1, 'a read in flight');
  const t0 = elapsed();
  world.fast = true;
  const off = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  assert.equal(off.success, true, off.error);
  const write = world.writes()[0];
  assert.ok(write.sentAt - t0 < 50, `the Off left ${write.sentAt - t0} ms after the click`);
  assert.equal(world.peak, 1, 'the read was closed before the Off opened its connection');
  assert.equal(gladys.fake.connectionStatus.connected, true, 'a cut read is not a failure');
  assert.equal(app.pause, undefined);
  // A pause: the IPX failing its reads.
  world.FP[1] = 'Confort';
  world.failReads = 500;
  await wait(10 * SECOND);
  assert.ok(app.pause, 'paused');
  const on = await cmd(relays[0], F('relay', 'r1', 'switch'), 1);
  assert.match(on.error, /ne répond pas/, 'a switch-on is refused during the pause');
  const off2 = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  assert.match(off2.error, /Envoyée/, 'sent (its read back failed with the reads)');
  assert.equal(world.FP[1], 'Arret');
  world.failReads = undefined;
  // The queue full of slow commands.
  world.FP[1] = 'Confort';
  app.pause = undefined;
  world.latency = 2 * SECOND;
  const many = [];
  for (let i = 0; i < 20; i += 1) {
    many.push(gladys.fake.setValue(relays[i % 5], relays[i % 5].features[0], 1));
  }
  const stop = gladys.fake.setValue(device, device.features[0], PILOT.OFF);
  const acks = await act(Promise.all([...many, stop]));
  assert.ok(
    acks.slice(0, 20).some((a) => /Trop de commandes/.test(a.error ?? '')),
    'the queue was full',
  );
  assert.equal(acks[20].success, true, acks[20].error);
  assert.equal(world.FP[1], 'Arret');
  app.stop();
});

test('a refused key: the Off is still tried', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx({ key: 'another' });
  const { app, start, cmd } = await setup({ config: v4Fp(), devices: [device], world });
  await start();
  assert.ok(app.refusedApplies());
  const before = world.requests.length;
  const off = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  assert.equal(off.success, false);
  assert.ok(world.requests.length > before, 'tried');
  assert.match(off.error, /refusé la clé d’API/);
  app.stop();
});

test('right after a restart, before any read: the V5 Off leaves from the ids kept in /data', async () => {
  const device = created('pilot-wire', 'x4fp7-2');
  const first = await setup({ version: 'v5', devices: [device] });
  await first.start();
  first.app.stop();
  const world = fakeIpx({ version: 'v5' });
  setV5Mode(world, 2, 'ioComfort_id');
  // Every read hangs: the Off must not wait for one.
  world.latency = (r) => (r.method === 'GET' ? 60 * SECOND : 20);
  const second = await setup({
    version: 'v5',
    devices: [device],
    store: first.store,
    clock: first.clock,
    world,
  });
  await second.app.connected(CONFIG.v5);
  const off = await second.cmd(device, F('pilot-wire', 'x4fp7-2', 'mode'), PILOT.OFF);
  assert.equal(v5Mode(world, 2), 'ioStop_id');
  const put = world.writes()[0];
  assert.equal(put.path.split('?')[0], '/api/core/io/313');
  assert.notEqual(off.error, undefined, 'unconfirmed while the reads hang');
  second.app.stop();
});

test('nothing asked before an Off leaves after it: the waiting heating mode is cancelled', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  const { app, start, act, gladys } = await setup({
    config: v4Fp({ allow_heating_modes: true }),
    devices: [device],
    world,
  });
  await start();
  world.latency = 1500;
  const feature = device.features[0];
  const results = await act(
    Promise.all([
      gladys.fake.setValue(device, feature, PILOT.ECO),
      gladys.fake.setValue(device, feature, PILOT.COMFORT),
      settle(2).then(() => gladys.fake.setValue(device, feature, PILOT.OFF)),
    ]),
  );
  assert.equal(world.FP[1], 'Arret', 'the Off is the last written');
  const fpWrites = world.writes().map((w) => /SetFP01=(\d)/.exec(w.path)[1]);
  assert.equal(fpWrites.at(-1), '3');
  assert.ok(!fpWrites.includes('0'), 'the Comfort never left');
  assert.match(results[1].error, /Annulée|Interrompue/);
  app.stop();
});

test('an Off the IPX does not apply is sent again by the reads, 3 times at most, then told; never lifted by time', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const { app, start, cmd, wait, gladys, store } = await setup({
    config: v4Fp(),
    devices: [device],
    world,
  });
  await start();
  world.ignoreWrites = true;
  const off = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  assert.match(off.error, /pas encore appliquée/);
  for (let i = 0; i < 6; i += 1) await wait(10 * SECOND);
  const writes = world.writes().filter((w) => /SetFP01=3/.test(w.path));
  assert.equal(writes.length, 1 + TIMINGS.resendMax);
  assert.match(message(gladys), /not applied after 3 tries.*FP1/);
  assert.equal(store.data.guards[0].code, 'fp1');
  await wait(3600 * SECOND);
  assert.ok(app.guards.has('fp1'), 'never lifted by time');
  // Applied at last (by hand on the IPX): confirmed.
  world.FP[1] = 'Arret';
  await wait(10 * SECOND);
  assert.equal(app.guards.get('fp1').confirmed, true);
  app.stop();
});

test('a confirmed Off is released by another value read twice in a row, not once', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  const { app, start, cmd, wait } = await setup({ config: v4Fp(), devices: [device], world });
  await start();
  await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  assert.equal(app.guards.get('fp1').confirmed, true);
  // After the follow-up reads of the command (5 s, 20 s), just after a round.
  await wait(25 * SECOND);
  world.FP[1] = 'Eco';
  await wait(10 * SECOND);
  assert.ok(app.guards.has('fp1'), 'read once: still held');
  await wait(10 * SECOND);
  assert.ok(!app.guards.has('fp1'), 'read twice: changed on the IPX');
  assert.equal(world.writes().length, 1, 'never sent again over a change made on the IPX');
  app.stop();
});

test('a later heating mode that left (option on) lifts the Off guard; refused by the IPX, it does not', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const { app, start, cmd } = await setup({
    config: v4Fp({ allow_heating_modes: true }),
    devices: [device],
    world,
  });
  await start();
  world.ignoreWrites = true;
  await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  assert.ok(app.guards.has('fp1'));
  world.queue.push((r) => (/SetFP/.test(r.path) ? { status: 429, json: {} } : undefined));
  await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.ECO);
  assert.ok(app.guards.has('fp1'), 'a 429 is not a newer command');
  world.ignoreWrites = false;
  const eco = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.ECO);
  assert.equal(eco.success, true, eco.error);
  assert.ok(!app.guards.has('fp1'));
  app.stop();
});

test('the API key is never in the logs, the statuses nor /data, even on failures', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  const { app, start, cmd, wait, lines, store, gladys } = await setup({
    config: v4Fp(),
    devices: [device],
    world,
  });
  await start();
  world.queue.push(new Error(`GET http://${ADDRESS}/api/xdevices.json?key=${KEY}`));
  await wait(10 * SECOND);
  world.refuseConnect = 50;
  await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  await wait(30 * SECOND);
  const all = [
    ...lines,
    JSON.stringify(store.data),
    JSON.stringify(gladys.fake.connectionStatuses),
    JSON.stringify(gladys.fake.discoveredDevices),
  ].join('\n');
  assert.ok(!all.includes(KEY), 'the key leaked');
  app.stop();
});

test('/data unreadable is not empty: nothing written over it, heating modes refused, the Off still goes', async () => {
  const device = created('pilot-wire', 'fp1');
  const store = memoryStore({ key: 'x', guards: [] });
  store.unreadable = true;
  const { app, start, cmd, world, gladys } = await setup({
    config: v4Fp({ allow_heating_modes: true }),
    devices: [device],
    store,
  });
  await start();
  assert.equal(store.saves, 0);
  assert.match(message(gladys), /\/data/);
  const eco = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.ECO);
  assert.match(eco.error, /\/data/);
  const off = await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  assert.equal(off.success, true, off.error);
  assert.equal(world.FP[1], 'Arret');
  app.stop();
});

test('nothing stale at "connected" nor at a device created long after the last read', async () => {
  const device = created('relay', 'r1');
  const world = fakeIpx();
  const { app, start, gladys, wait } = await setup({ world });
  await start();
  world.queue.push(new Error('down'), new Error('down'), new Error('down'));
  await wait(10 * SECOND);
  const count = gladys.fake.states.length;
  await gladys.fake.deviceCreated(device);
  await app.connected(CONFIG.v4);
  await app.flush();
  assert.equal(gladys.fake.states.length, count, 'no old value republished');
  app.stop();
});

test('the test button reads now once due, refused key included, and stays paced', async () => {
  const { app, start, world, wait, act } = await setup({
    config: { ...CONFIG.v4, api_key: 'nope' },
  });
  await start();
  const before = rounds(world, 'v4').length;
  await wait(10 * SECOND);
  world.key = 'nope';
  const text = await act(app.testConnection());
  assert.match(text.en, /Connected/);
  assert.equal(rounds(world, 'v4').length, before + 1);
  assert.equal(app.refusedApplies(), false);
  const again = await act(app.testConnection());
  assert.equal(rounds(world, 'v4').length, before + 1, 'cooldown');
  assert.ok(again);
  app.stop();
});
