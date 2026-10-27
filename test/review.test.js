// -----------------------------------------------------------------------------
// The rules the r1 review found unguarded: a clicked Off cuts any request,
// read backs and resends included; a guard put back never overwrites a newer
// one; a relay no longer listed is never driven again; an Off clicked before
// the configuration is read; one configuration at a time; acks within 5 s;
// and one test per surviving mutation.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MULTI, PILOT, TIMINGS } from '../src/constants.js';
import { PRIORITY } from '../src/ipx/client.js';
import { memoryStore, normalizeMemory } from '../src/store.js';
import { fakeIpx, setV5Mode } from './helpers/fakeIpx.js';
import { CONFIG, F, SECOND, created, settle, setup } from './helpers/app.js';

const message = (gladys, lang = 'en') => gladys.fake.connectionStatus?.message?.[lang] ?? '';
const v4 = (over = {}) => ({ ...CONFIG.v4, v4_extensions: 'FP1-FP4', relays: 'R1, R2', ...over });

/** A promise whose settling time (virtual ms) is recorded. */
const timed = (clock, promise) => {
  const out = { at: undefined };
  out.promise = promise.then((value) => {
    out.at = clock.elapsed;
    return value;
  });
  return out;
};

test('B1: a clicked Off cuts the stuck read back of an earlier Off and leaves at once', async () => {
  const relays = [
    created('relay', 'r1', { relayKind: 'switch' }),
    created('relay', 'r2', { relayKind: 'switch' }),
  ];
  const world = fakeIpx();
  world.R[1] = 1;
  world.R[2] = 1;
  const { app, start, act, gladys, clock } = await setup({ config: v4(), devices: relays, world });
  await start();
  // Every read hangs from now on (the IPX takes the writes).
  world.latency = (r) => (/Get=all/.test(r.path) ? 60 * SECOND : 20);
  const first = gladys.fake.setValue(relays[0], relays[0].features[0], 0);
  await act(settle(5).then(() => new Promise((r) => clock.timers.setTimeout(r, 300))));
  const clicked = clock.elapsed;
  const acks = await act(
    Promise.all([first, gladys.fake.setValue(relays[1], relays[1].features[0], 0)]),
  );
  const write = world.writes().find((w) => /ClearR=02/.test(w.path));
  assert.ok(write, 'ClearR=02 written');
  assert.ok(
    write.sentAt - clicked < 50,
    `ClearR=02 left ${write.sentAt - clicked} ms after its click`,
  );
  assert.equal(world.R[2], 0);
  assert.equal(world.peak, 1);
  assert.ok(acks.every((a) => a.error === undefined || /Envoyée/.test(a.error)));
  app.stop();
});

test('B1: a clicked Off without answer for 1 s is cut when another Off waits', async () => {
  const zones = [created('pilot-wire', 'fp1'), created('pilot-wire', 'fp2')];
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  world.FP[2] = 'Confort';
  const { app, start, act, gladys, clock } = await setup({
    config: v4({ poll_interval: 300 }),
    devices: zones,
    world,
  });
  await start();
  world.latency = (r) => (/SetFP01/.test(r.path) ? 5 * SECOND : 20);
  const t0 = clock.elapsed;
  const first = gladys.fake.setValue(zones[0], zones[0].features[0], PILOT.OFF);
  const second = settle(3).then(() =>
    gladys.fake.setValue(zones[1], zones[1].features[0], PILOT.OFF),
  );
  const [ack1, ack2] = await act(Promise.all([first, second]));
  assert.equal(ack2.success, true, ack2.error);
  assert.match(ack1.error, /Envoyée/);
  const write = world.writes().find((w) => /SetFP02=3/.test(w.path) && w.sentAt !== undefined);
  assert.ok(write.sentAt - t0 < 1.2 * SECOND, `left at ${write.sentAt - t0} ms`);
  assert.equal(world.FP[2], 'Arret');
  app.stop();
});

test('B1: an Off that could not leave is sent again as soon as the lane frees, before any read', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const { app, start, act, gladys, clock } = await setup({
    config: v4({ poll_interval: 300 }),
    devices: [device],
    world,
  });
  await start();
  // Refused for longer than the 250 ms of tries, then the IPX answers again.
  world.refuseConnect = 6;
  const t0 = clock.elapsed;
  const ack = await act(gladys.fake.setValue(device, device.features[0], PILOT.OFF));
  assert.match(ack.error, /Pas encore envoyée.*renvoyée dès que l’IPX800 est libre/);
  await act(new Promise((r) => clock.timers.setTimeout(r, 500)));
  const write = world.writes().find((w) => /SetFP01=3/.test(w.path) && w.sentAt !== undefined);
  assert.ok(write, 'SetFP01=3 written');
  assert.ok(write.sentAt - t0 < SECOND, `left at ${write.sentAt - t0} ms`);
  assert.equal(world.FP[1], 'Arret');
  app.stop();
});

test('B2: a Comfort waiting for a slow /data never leaves after an Off clicked meanwhile', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const store = memoryStore();
  const { app, start, cmd, act, gladys, clock } = await setup({
    config: v4({ allow_heating_modes: true }),
    devices: [device],
    world,
    store,
  });
  await start();
  await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.FROST_PROTECTION);
  const save = store.save.bind(store);
  store.save = async (d) => {
    await new Promise((r) => clock.timers.setTimeout(r, 200));
    return save(d);
  };
  const feature = device.features[0];
  const comfort = gladys.fake.setValue(device, feature, PILOT.COMFORT);
  const later = new Promise((r) => clock.timers.setTimeout(r, 60)).then(() =>
    gladys.fake.setValue(device, feature, PILOT.OFF),
  );
  const [c] = await act(Promise.all([comfort, later]));
  await act(new Promise((r) => clock.timers.setTimeout(r, 1000)));
  assert.equal(world.FP[1], 'Arret');
  assert.ok(
    !world.writes().some((w) => /SetFP01=0/.test(w.path) && w.sentAt !== undefined),
    'the Comfort never left',
  );
  assert.match(c.error, /Annulée/);
  app.stop();
});

test('B3: a relay removed from the list is never switched again, nor after a restart', async () => {
  const relay = created('relay', 'r1', { relayKind: 'switch' });
  const world = fakeIpx();
  world.R[1] = 1;
  const { app, start, cmd, wait, gladys, store, clock } = await setup({
    config: v4(),
    devices: [relay],
    world,
  });
  await start();
  world.ignoreWrites = true;
  await cmd(relay, F('relay', 'r1', 'switch'), 0);
  assert.ok(app.guards.has('r1'));
  await gladys.fake.configUpdated(v4({ relays: 'R2' }));
  assert.equal(app.guards.has('r1'), false, 'dropped at once');
  assert.deepEqual(store.data.guards, [], 'and in /data');
  const count = world.writes().length;
  await wait(60 * SECOND);
  assert.equal(world.writes().length, count, 'no ClearR=01 once unlisted');
  assert.equal(app.guards.has('r1'), false);
  assert.deepEqual(store.data.guards, []);
  app.stop();
  // A guard of R1 in /data, R1 not listed: nothing at start.
  store.data.guards = [{ code: 'r1', kind: 'relay', value: 0, resends: 0, confirmed: false }];
  const again = await setup({ config: v4({ relays: 'R2' }), store, clock, devices: [relay] });
  await again.start();
  await again.wait(30 * SECOND);
  assert.ok(!again.world.writes().some((w) => /ClearR=01/.test(w.path)));
  assert.deepEqual(again.store.data.guards, []);
  again.app.stop();
  // Read back from /data with R1 not listed: dropped before anything can send it.
  again.app.guards.clear();
  again.app.adoptMemory(
    normalizeMemory(
      { key: again.app.config.key, guards: [{ code: 'r1', kind: 'relay', value: 0 }] },
      clock.now(),
    ),
    clock.now(),
    clock.monotonic(),
  );
  assert.equal(again.app.guards.has('r1'), false);
});

test('I1: an Off clicked before the configuration is read asks for it and leaves once it comes', async () => {
  let calls = 0;
  let fail = true;
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const { app, gladys, wait, act, clock } = await setup({
    config: v4(),
    devices: [device],
    world,
    getConfig: async () => {
      calls += 1;
      if (fail) throw new Error('busy');
      return v4();
    },
  });
  await app.onConnected(() => gladys.getConfig());
  await wait(SECOND);
  const before = calls;
  const ack = await act(gladys.fake.setValue(device, device.features[0], PILOT.OFF));
  assert.ok(calls > before, 'the click asked for the configuration');
  assert.match(ack.error, /gardée et envoyée dès sa lecture/);
  fail = false;
  await wait(6 * SECOND);
  assert.ok(
    world.writes().some((w) => /SetFP01=3/.test(w.path)),
    'sent once read',
  );
  assert.equal(world.FP[1], 'Arret');
  // Read in the ack when Gladys answers then.
  const second = await setup({ config: v4(), devices: [device], getConfig: async () => v4() });
  second.app.configLoader = () => second.gladys.getConfig();
  const ok = await second.act(second.gladys.fake.setValue(device, device.features[0], PILOT.OFF));
  assert.equal(ok.success, true, ok.error);
  app.stop();
  second.app.stop();
  void clock;
});

test('I2: two saves in a row apply one after the other, the last wins, one request at a time', async () => {
  const world = fakeIpx();
  world.latency = 300;
  const store = memoryStore();
  const { app, start, act, clock } = await setup({ world, store });
  await start();
  const load = store.load.bind(store);
  let loads = 0;
  store.load = async () => {
    loads += 1;
    await new Promise((r) => clock.timers.setTimeout(r, 80));
    return load();
  };
  await act(
    Promise.all([
      app.configUpdated({ ...CONFIG.v4, api_key: 'other-key' }),
      // Saved again before the first one started: it is skipped.
      app.configUpdated({ ...CONFIG.v4, api_key: 'last-key' }),
    ]),
  );
  await act(new Promise((r) => clock.timers.setTimeout(r, 2000)));
  assert.equal(world.peak, 1);
  assert.equal(loads, 1, 'the superseded configuration never starts');
  assert.equal(app.config.apiKey, 'last-key');
  assert.ok(
    !world.requests.some((r) => /other-key/.test(r.path)),
    'the superseded one never reads',
  );
  app.stop();
});

test('I3: relays clicked one after the other on a slow IPX: every ack within 5 s', async () => {
  const relays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    created('relay', `r${n}`, { relayKind: 'switch' }),
  );
  const world = fakeIpx();
  const { app, start, act, gladys, clock } = await setup({
    config: v4({ relays: 'R1,R2,R3,R4,R5,R6,R7,R8' }),
    devices: relays,
    world,
  });
  await start();
  world.latency = 700;
  const acks = [];
  for (const relay of relays) {
    const t = clock.elapsed;
    const ack = timed(clock, gladys.fake.setValue(relay, relay.features[0], 1));
    acks.push({ t, ack });
    await act(new Promise((r) => clock.timers.setTimeout(r, 600)));
  }
  await act(Promise.all(acks.map((a) => a.ack.promise)));
  for (const { t, ack } of acks) assert.ok(ack.at - t < 5000, `ack after ${ack.at - t} ms`);
  app.stop();
});

test('M2: switching off a listed relay goes during a pause; switching it on does not', async () => {
  const relay = created('relay', 'r1', { relayKind: 'switch' });
  const world = fakeIpx();
  world.R[1] = 1;
  const { app, start, cmd, wait } = await setup({ config: v4(), devices: [relay], world });
  await start();
  world.failReads = 500;
  await wait(10 * SECOND);
  assert.ok(app.pause);
  const on = await cmd(relay, F('relay', 'r1', 'switch'), 1);
  assert.match(on.error, /ne répond pas/);
  await cmd(relay, F('relay', 'r1', 'switch'), 0);
  assert.ok(world.writes().some((w) => /ClearR=01/.test(w.path)));
  assert.equal(world.R[1], 0);
  app.stop();
});

test('M4: the heating option is checked again right before the write', async () => {
  const zones = [created('pilot-wire', 'fp1'), created('pilot-wire', 'fp2')];
  const world = fakeIpx();
  const { app, start, act, gladys } = await setup({
    config: v4({ allow_heating_modes: true }),
    devices: zones,
    world,
  });
  await start();
  world.latency = 1000;
  const eco1 = gladys.fake.setValue(zones[0], zones[0].features[0], PILOT.ECO);
  const eco2 = gladys.fake.setValue(zones[1], zones[1].features[0], PILOT.ECO);
  await settle(5);
  await gladys.fake.configUpdated(v4({ allow_heating_modes: false }));
  const [, second] = await act(Promise.all([eco1, eco2]));
  assert.match(second.error, /désactivés/);
  assert.ok(!world.writes().some((w) => /SetFP02/.test(w.path)));
  app.stop();
});

test('M7: unknown reads never release a confirmed Off', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  const { app, start, cmd, wait } = await setup({ config: v4(), devices: [device], world });
  await start();
  await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  await wait(25 * SECOND);
  world.FP[1] = '???';
  await wait(30 * SECOND);
  assert.ok(app.guards.has('fp1'), 'still held after unknown reads');
  app.stop();
});

test('M8: a read that left before the guard was sent never checks it', async () => {
  const { app, start } = await setup({ config: v4() });
  await start();
  app.guards.set('fp1', {
    code: 'fp1',
    kind: 'pilot-wire',
    value: PILOT.OFF,
    resends: 0,
    confirmed: true,
    other: PILOT.ECO,
    seq: 1,
    sentAt: 1000,
    inFlight: false,
  });
  app.model.set('fp1', { ...app.model.get('fp1'), value: PILOT.ECO, at: 500 });
  app.applyRead(500);
  assert.ok(app.guards.has('fp1'), 'an older read is not the second one');
  app.stop();
});

test('M10: a heating mode waiting behind an Off is refused at once, not at its turn', async () => {
  const zones = [created('pilot-wire', 'fp1'), created('pilot-wire', 'fp2')];
  const world = fakeIpx();
  const store = memoryStore();
  const { app, start, act, gladys, clock } = await setup({
    config: v4({ allow_heating_modes: true }),
    devices: zones,
    world,
    store,
  });
  await start();
  // A slow /data: the Eco of fp2 holds the queue (nothing in flight to cut).
  const save = store.save.bind(store);
  store.save = async (d) => {
    await new Promise((r) => clock.timers.setTimeout(r, 1000));
    return save(d);
  };
  const busy = gladys.fake.setValue(zones[1], zones[1].features[0], PILOT.ECO);
  const waiting = timed(clock, gladys.fake.setValue(zones[0], zones[0].features[0], PILOT.COMFORT));
  await settle(5);
  const clicked = clock.elapsed;
  const off = gladys.fake.setValue(zones[0], zones[0].features[0], PILOT.OFF);
  const [, w] = await act(Promise.all([busy, waiting.promise, off]));
  assert.match(w.error, /Annulée/);
  assert.ok(waiting.at - clicked < 100, `refused ${waiting.at - clicked} ms after the Off`);
  app.stop();
});

test('M11: a read back that left before a write is never shared with it', async () => {
  const world = fakeIpx();
  world.latency = 1000;
  const { app, start, clock, wait } = await setup({ config: v4(), world });
  await start();
  await wait(2000);
  const first = app.readBack(PRIORITY.CONFIRM, clock.monotonic() + 5000);
  first.catch(() => {});
  await wait(20);
  assert.ok(app.readBackJob.started, 'the first read back left');
  const written = clock.monotonic();
  const second = app.readBack(PRIORITY.CONFIRM, clock.monotonic() + 5000, { after: written });
  second.catch(() => {});
  assert.notEqual(second, first);
  const third = app.readBack(PRIORITY.CONFIRM, clock.monotonic() + 5000, { after: written });
  assert.equal(third, second, 'one not left yet is shared');
  app.stop();
});

test('M17: a command the reads contradict is told in the status', async () => {
  const relay = created('relay', 'r1', { relayKind: 'switch' });
  const world = fakeIpx();
  const { app, start, cmd, wait, gladys } = await setup({ config: v4(), devices: [relay], world });
  await start();
  world.ignoreWrites = true;
  await cmd(relay, F('relay', 'r1', 'switch'), 1);
  await wait(10 * SECOND);
  assert.match(message(gladys), /Last command not applied.*R1/);
  app.stop();
});

test('M19: a guard kept in /data leaves at start, before any read', async () => {
  const store = memoryStore();
  const first = await setup({ config: v4(), store });
  await first.start();
  first.app.stop();
  store.data.guards = [{ code: 'fp1', kind: 'pilot-wire', value: 0, resends: 0, confirmed: false }];
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const second = await setup({ config: v4(), store, clock: first.clock, world });
  await second.start();
  assert.ok(world.writes().some((w) => /SetFP01=3/.test(w.path)));
  assert.equal(world.reads().length, 0, 'read less than an interval ago: no round yet');
  second.app.stop();
});

test('M22: a command cuts a slow read of the polling', async () => {
  const relay = created('relay', 'r1', { relayKind: 'switch' });
  const world = fakeIpx();
  const { app, start, wait, act, gladys, clock, elapsed } = await setup({
    config: v4(),
    devices: [relay],
    world,
  });
  await start();
  world.latency = (r) => (/Get=all/.test(r.path) && !world.fast ? 4 * SECOND : 20);
  await wait(10 * SECOND);
  assert.equal(world.inFlight, 1);
  const t0 = elapsed();
  world.fast = true;
  await act(gladys.fake.setValue(relay, relay.features[0], 1));
  const write = world.writes()[0];
  assert.ok(write.sentAt - t0 < 50, `left ${write.sentAt - t0} ms after the click`);
  app.stop();
  void clock;
});

test('V5: several modes on is told, never published, and the Off is sent again', async () => {
  const device = created('pilot-wire', 'x4fp7-1');
  const world = fakeIpx({ version: 'v5' });
  const { app, start, cmd, wait, gladys } = await setup({
    version: 'v5',
    devices: [device],
    world,
  });
  await start();
  setV5Mode(world, 1, 'ioComfort_id');
  world.ignoreWrites = true;
  // Stop and Comfort both on (a firmware that does not clear the other modes).
  world.io.set(312, true);
  await cmd(device, F('pilot-wire', 'x4fp7-1', 'mode'), PILOT.OFF);
  await wait(10 * SECOND);
  assert.equal(app.model.get('x4fp7-1').value, MULTI);
  assert.match(message(gladys), /several modes on.*X4FP7-1/);
  const puts = world.writes().filter((w) => w.path.startsWith('/api/core/io/312'));
  assert.ok(puts.length >= 2, `the Off sent again (${puts.length})`);
  const states = gladys.fake.states.filter((s) =>
    s.device_feature_external_id.endsWith('x4fp7-1:mode'),
  );
  assert.ok(states.every((s) => s.state >= 0));
  app.stop();
});

test('V4: a command answered "status: Error" does not lift the Off guard', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  const { app, start, cmd } = await setup({
    config: v4({ allow_heating_modes: true }),
    devices: [device],
    world,
  });
  await start();
  world.ignoreWrites = true;
  await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.OFF);
  world.queue.push((r) => (/SetFP/.test(r.path) ? { json: { status: 'Error' } } : undefined));
  await cmd(device, F('pilot-wire', 'fp1', 'mode'), PILOT.ECO);
  assert.ok(app.guards.has('fp1'));
  assert.ok(TIMINGS.resendMax >= 1);
  app.stop();
});

// --- Review r2 ----------------------------------------------------------------------

/** Gladys slow to take the status and the Discovery list (4 s each, virtual). */
const slowGladys = (gladys, clock) => {
  for (const name of ['publishDiscoveredDevices', 'setConnectionStatus']) {
    const original = gladys[name].bind(gladys);
    gladys[name] = async (...args) => {
      await new Promise((r) => clock.timers.setTimeout(r, 4 * SECOND));
      return original(...args);
    };
  }
};

test('r2 B1: an Off clicked during a slow start (Gladys slow) is sent in that start', async () => {
  let calls = 0;
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const { app, gladys, wait, act, clock } = await setup({
    config: v4(),
    devices: [device],
    world,
    getConfig: async () => {
      calls += 1;
      if (calls === 1) throw new Error('busy');
      return v4();
    },
  });
  slowGladys(gladys, clock);
  app.onConnected(() => gladys.getConfig());
  await wait(SECOND);
  const t0 = clock.elapsed;
  const ack = await act(gladys.fake.setValue(device, device.features[0], PILOT.OFF));
  const write = world.writes().find((w) => /SetFP01=3/.test(w.path) && w.sentAt !== undefined);
  assert.ok(write, `sent (ack: ${JSON.stringify(ack)})`);
  assert.ok(write.sentAt - t0 < 3.5 * SECOND, `left ${write.sentAt - t0} ms after the click`);
  assert.equal(app.pendingProtectives.size, 0, 'nothing left for a later start');
  app.stop();
  app.clearConfigTimer();
});

test('r2 B1: an Off kept in /data leaves within a second of the start, whatever Gladys does', async () => {
  const store = memoryStore();
  const first = await setup({ config: v4(), store });
  await first.start();
  first.app.stop();
  store.data.guards = [{ code: 'fp1', kind: 'pilot-wire', value: 0, resends: 0, confirmed: false }];
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const second = await setup({ config: v4(), store, clock: first.clock, world });
  slowGladys(second.gladys, second.clock);
  const t0 = second.clock.elapsed;
  second.app.connected(v4());
  // No time moves: everything up to the write happens without waiting for Gladys.
  await settle(50);
  const write = world.writes().find((w) => /SetFP01=3/.test(w.path) && w.sentAt !== undefined);
  assert.ok(write, 'sent before Gladys answered');
  assert.ok(write.sentAt - t0 < SECOND, `left ${write.sentAt - t0} ms after the start`);
  await second.wait(10 * SECOND);
  second.app.stop();
});

test('r2 B1: an Off waiting for the configuration that is then unknown is told, not dropped silently', async () => {
  let calls = 0;
  const device = created('relay', 'r7', { relayKind: 'switch' });
  const { app, gladys, wait, act } = await setup({
    config: v4(),
    devices: [device],
    getConfig: async () => {
      calls += 1;
      if (calls <= 2) throw new Error('busy');
      return v4();
    },
  });
  await app.onConnected(() => gladys.getConfig());
  await act(gladys.fake.setValue(device, device.features[0], 0));
  await wait(10 * SECOND);
  assert.match(message(gladys), /clicked before the configuration was read, not sent.*R7/);
  app.stop();
  app.clearConfigTimer();
});

test('r2 I1: a round left in the queue past its deadline is no failure of the IPX', async () => {
  const relays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    created('relay', `r${n}`, { relayKind: 'switch' }),
  );
  const world = fakeIpx();
  const { app, start, act, gladys, clock, wait } = await setup({
    config: v4({ relays: 'R1,R2,R3,R4,R5,R6,R7,R8', poll_interval: 5 }),
    devices: relays,
    world,
  });
  await start();
  await wait(3500);
  world.latency = 700;
  const acks = [];
  for (const relay of relays) {
    acks.push(gladys.fake.setValue(relay, relay.features[0], 1));
    await act(new Promise((r) => clock.timers.setTimeout(r, 250)));
  }
  await act(Promise.all(acks));
  assert.equal(app.failures, 0);
  assert.equal(app.pause, undefined);
  assert.doesNotMatch(message(gladys), /does not answer/);
  const after = await act(gladys.fake.setValue(relays[0], relays[0].features[0], 0));
  assert.ok(after.success || /Envoyée/.test(after.error), after.error);
  app.stop();
});

test('r2: a retry of a clicked Off never leaves after a newer command on its target', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const { app, start, act, gladys } = await setup({ config: v4(), devices: [device], world });
  await start();
  world.refuseConnect = 1;
  const feature = device.features[0];
  await act(
    Promise.all([
      gladys.fake.setValue(device, feature, PILOT.OFF),
      gladys.fake.setValue(device, feature, PILOT.FROST_PROTECTION),
    ]),
  );
  await act(new Promise((r) => setImmediate(r)));
  const sent = world
    .writes()
    .filter((w) => w.sentAt !== undefined)
    .map((w) => w.path.slice(-1));
  assert.equal(world.FP[1], 'Hors Gel', `writes ${sent}`);
  assert.equal(sent.at(-1), '2');
  app.stop();
});

test('r2: "several modes on" read twice never releases a confirmed Off', async () => {
  const device = created('pilot-wire', 'x4fp7-1');
  const world = fakeIpx({ version: 'v5' });
  const { app, start, cmd, wait } = await setup({ version: 'v5', devices: [device], world });
  await start();
  setV5Mode(world, 1, 'ioComfort_id');
  await cmd(device, F('pilot-wire', 'x4fp7-1', 'mode'), PILOT.OFF);
  assert.equal(app.guards.get('x4fp7-1').confirmed, true);
  await wait(25 * SECOND);
  world.io.set(300, true);
  await wait(30 * SECOND);
  assert.equal(app.model.get('x4fp7-1').value, MULTI);
  assert.ok(app.guards.has('x4fp7-1'), 'unreadable is never "changed elsewhere"');
  app.stop();
});

test('r2: an Off not sent in time in a scene of 5 on a slow IPX goes before the read backs', async () => {
  const zones = [1, 2, 3, 4, 5].map((n) => created('pilot-wire', `fp${n}`));
  const world = fakeIpx();
  for (let n = 1; n <= 5; n += 1) world.FP[n] = 'Confort';
  const { app, start, act, gladys, wait } = await setup({
    config: v4({ v4_extensions: 'FP1-FP8', poll_interval: 300 }),
    devices: zones,
    world,
  });
  await start();
  world.latency = 900;
  await act(Promise.all(zones.map((z) => gladys.fake.setValue(z, z.features[0], PILOT.OFF))));
  await wait(3000);
  const sent = world.requests.filter((r) => r.sentAt !== undefined);
  const fifth = sent.findIndex((r) => /SetFP05=3/.test(r.path));
  const readBack = sent.findIndex((r, i) => i > 0 && /Get=all/.test(r.path));
  assert.ok(fifth !== -1 && fifth < readBack, 'the 5th Off before the read backs');
  assert.deepEqual(world.FP.slice(1, 6), ['Arret', 'Arret', 'Arret', 'Arret', 'Arret']);
  app.stop();
});

test('r2: /data is never written between the reset of a start and its read of /data', async () => {
  const store = memoryStore();
  const first = await setup({ config: v4(), store });
  await first.start();
  first.app.stop();
  store.data.guards = [{ code: 'fp1', kind: 'pilot-wire', value: 0, resends: 0, confirmed: false }];
  const second = await setup({ config: v4(), store, clock: first.clock });
  const load = store.load.bind(store);
  store.load = async () => {
    await new Promise((r) => second.clock.timers.setTimeout(r, 80));
    return load();
  };
  const started = second.app.connected(v4());
  await settle(5);
  await second.app.saveMemory();
  assert.equal(store.data.guards.length, 1, 'the kept Off is still in /data');
  await second.act(started);
  assert.ok(second.app.guards.has('fp1'));
  second.app.stop();
});

// --- Review r3 ----------------------------------------------------------------------

/** s17 of the review: Frost refused at its first try, Off clicked 15 ms into its 50 ms wait. */
const olderFrostThenOff = async ({ poll }) => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  const ctx = await setup({ config: v4({ poll_interval: poll }), devices: [device], world });
  await ctx.start();
  world.refuseConnect = 1;
  const feature = device.features[0];
  const frost = ctx.gladys.fake.setValue(device, feature, PILOT.FROST_PROTECTION);
  const off = new Promise((r) => ctx.clock.timers.setTimeout(r, 15)).then(() =>
    ctx.gladys.fake.setValue(device, feature, PILOT.OFF),
  );
  const [f, o] = await ctx.act(Promise.all([frost, off]));
  return { ...ctx, f, o };
};
const leftWrites = (world) =>
  world
    .writes()
    .filter((w) => w.sentAt !== undefined)
    .map((w) => /(SetFP\d\d=\d|SetR=\d\d|ClearR=\d\d)$/.exec(w.path)?.[1]);

test('r3 B1 (s17): an older Frost waiting to try again never leaves after a newer Off', async () => {
  const { app, world, act, clock, f, o } = await olderFrostThenOff({ poll: 300 });
  await act(new Promise((r) => clock.timers.setTimeout(r, 500)));
  assert.deepEqual(leftWrites(world), ['SetFP01=3'], 'only the Off left');
  assert.equal(world.FP[1], 'Arret');
  assert.match(f.error, /Annulée/);
  assert.equal(o.success, true, o.error);
  app.stop();
});

test('r3 B1 (s17b): that newer Off stays held, never lifted as "changed on the IPX"', async () => {
  const { app, world, wait } = await olderFrostThenOff({ poll: 5 });
  await wait(30 * SECOND);
  const guard = app.guards.get('fp1');
  assert.ok(guard, 'the Off is still held');
  assert.equal(guard.value, PILOT.OFF);
  assert.equal(guard.confirmed, true);
  assert.equal(world.FP[1], 'Arret');
  assert.ok(!leftWrites(world).includes('SetFP01=2'), 'the Frost never left');
  app.stop();
});

test('r3 B1: a retry already queued is checked again right before it leaves', async () => {
  const zones = [created('pilot-wire', 'fp1'), created('pilot-wire', 'fp2')];
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  world.FP[2] = 'Confort';
  const { app, start, act, gladys, clock } = await setup({
    config: v4({ poll_interval: 300 }),
    devices: zones,
    world,
  });
  await start();
  // Frost on fp1 refused at its first try; an Off on fp2 holds the lane 500 ms, so the
  // retry of the Frost waits in the queue when an Off is clicked on fp1.
  world.refuseConnect = 1;
  world.latency = (r) => (/SetFP02=3/.test(r.path) ? 500 : 20);
  const later = (ms, zone, mode) =>
    new Promise((r) => clock.timers.setTimeout(r, ms)).then(() =>
      gladys.fake.setValue(zone, zone.features[0], mode),
    );
  const frost = gladys.fake.setValue(zones[0], zones[0].features[0], PILOT.FROST_PROTECTION);
  const [f, , o] = await act(
    Promise.all([frost, later(10, zones[1], PILOT.OFF), later(120, zones[0], PILOT.OFF)]),
  );
  await act(new Promise((r) => clock.timers.setTimeout(r, 500)));
  assert.deepEqual(leftWrites(world), ['SetFP02=3', 'SetFP01=3']);
  assert.equal(world.FP[1], 'Arret');
  assert.match(f.error, /Annulée/);
  assert.equal(o.success, true, o.error);
  app.stop();
});

test('r3: an older command cut by the Off, then handled late by the IPX, never lifts the Off', async () => {
  const device = created('pilot-wire', 'fp1');
  const world = fakeIpx();
  world.FP[1] = 'Eco';
  const { app, start, act, wait, gladys, clock, lines } = await setup({
    config: v4({ allow_heating_modes: true, poll_interval: 300 }),
    devices: [device],
    world,
  });
  await start();
  // This IPX takes the Comfort 2 s after it came, though its request was cut by the Off.
  world.latency = (r) => (/SetFP01=0/.test(r.path) ? 2 * SECOND : 20);
  world.queue.push((r) => {
    if (!/SetFP01=0/.test(r.path)) return undefined;
    clock.timers.setTimeout(() => {
      world.FP[1] = 'Confort';
    }, 2 * SECOND);
    return { json: { product: 'IPX800_V4', status: 'Success' } };
  });
  const feature = device.features[0];
  const comfort = gladys.fake.setValue(device, feature, PILOT.COMFORT);
  const off = new Promise((r) => clock.timers.setTimeout(r, 200)).then(() =>
    gladys.fake.setValue(device, feature, PILOT.OFF),
  );
  const [c, o] = await act(Promise.all([comfort, off]));
  assert.match(c.error, /Envoyée, sans confirmation/);
  assert.equal(o.success, true, o.error);
  await wait(30 * SECOND);
  assert.equal(world.FP[1], 'Arret', 'the Off sent again over the late Comfort');
  assert.equal(app.guards.get('fp1')?.value, PILOT.OFF, 'still held');
  assert.ok(lines.some((l) => /FP1 shows an older command of the integration/.test(l)));
  app.stop();
});

/** V4 with the heating modes allowed; `at(ms, zone, mode)` clicks `ms` from now (its ack). */
const heating = async (poll) => {
  const zones = [1, 2, 3].map((n) => created('pilot-wire', `fp${n}`));
  const world = fakeIpx();
  const ctx = await setup({
    config: v4({ allow_heating_modes: true, poll_interval: poll }),
    devices: zones,
    world,
  });
  await ctx.start();
  const at = (ms, zone, mode) =>
    new Promise((r) => ctx.clock.timers.setTimeout(r, ms)).then(() =>
      ctx.gladys.fake.setValue(zones[zone], zones[zone].features[0], mode),
    );
  const later = (ms, fn) => ctx.clock.timers.setTimeout(fn, ms);
  return { ...ctx, at, later };
};

test('r3: a command of ours answered before the Off is no reason to keep it over a change on the IPX', async () => {
  const { app, world, act, wait, at, later } = await heating(300);
  // fp1: a Comfort answered, an Off 1 s later, then Comfort set on the IPX itself.
  world.FP[1] = 'Eco';
  await act(Promise.all([at(0, 0, PILOT.COMFORT), at(SECOND, 0, PILOT.OFF)]));
  later(SECOND, () => (world.FP[1] = 'Confort'));
  await wait(30 * SECOND);
  assert.equal(app.guards.has('fp1'), false, 'released: changed on the IPX');
  assert.equal(world.FP[1], 'Confort');
  // fp2: a Frost still in flight when the Off comes, answered before the Off leaves; then
  // Frost set on the IPX itself.
  world.FP[2] = 'Confort';
  world.latency = (r) => (/SetFP02=2/.test(r.path) ? 300 : 20);
  await act(Promise.all([at(0, 1, PILOT.FROST_PROTECTION), at(100, 1, PILOT.OFF)]));
  later(SECOND, () => (world.FP[2] = 'Hors Gel'));
  await wait(30 * SECOND);
  assert.equal(app.guards.has('fp2'), false, 'released: changed on the IPX');
  assert.equal(world.FP[2], 'Hors Gel');
  // fp3: a Comfort the IPX refuses ("status": "Error"), an Off 1 s later, then Comfort set on
  // the IPX itself.
  world.FP[3] = 'Eco';
  world.queue.push((r) => (/SetFP03=0/.test(r.path) ? { json: { status: 'Error' } } : undefined));
  const [refused] = await act(Promise.all([at(0, 2, PILOT.COMFORT), at(SECOND, 2, PILOT.OFF)]));
  assert.match(refused.error, /répondu une erreur/);
  later(SECOND, () => (world.FP[3] = 'Confort'));
  await wait(30 * SECOND);
  assert.equal(app.guards.has('fp3'), false, 'released: changed on the IPX');
  assert.equal(world.FP[3], 'Confort');
  app.stop();
});

test('r3: a command of ours left unanswered more than 5 s before the Off is no reason either', async () => {
  const { app, world, act, wait, at, later } = await heating(300);
  world.FP[1] = 'Eco';
  // The Comfort is taken, its answer never comes (4.3 s); the Off 6 s after it left.
  world.latency = (r) => (/SetFP01=0/.test(r.path) ? 10 * SECOND : 20);
  const [c, o] = await act(Promise.all([at(0, 0, PILOT.COMFORT), at(6 * SECOND, 0, PILOT.OFF)]));
  assert.match(c.error, /Envoyée, sans confirmation/);
  assert.equal(o.success, true, o.error);
  later(SECOND, () => (world.FP[1] = 'Confort'));
  await wait(30 * SECOND);
  assert.equal(app.guards.has('fp1'), false, 'released: changed on the IPX');
  assert.equal(world.FP[1], 'Confort');
  app.stop();
});

test('r3: after a restart, an old unanswered command of ours is no reason either', async () => {
  const { app, world, act, wait, at } = await heating(5);
  world.FP[1] = 'Eco';
  world.latency = (r) => (/SetFP01=0/.test(r.path) ? 10 * SECOND : 20);
  await act(Promise.all([at(0, 0, PILOT.COMFORT), at(6 * SECOND, 0, PILOT.OFF)]));
  world.latency = 20;
  await wait(10 * SECOND);
  assert.equal(app.guards.get('fp1')?.confirmed, true);
  // Comfort set on the IPX itself, then a new API key: the integration starts again, the
  // Off taken back from /data; the first read after it shows the Comfort.
  world.FP[1] = 'Confort';
  world.key = 'An0therKey-7';
  await app.configUpdated(
    v4({ allow_heating_modes: true, poll_interval: 5, api_key: 'An0therKey-7' }),
  );
  assert.equal(app.guards.get('fp1')?.stale, undefined);
  await wait(30 * SECOND);
  assert.equal(app.guards.has('fp1'), false, 'released: changed on the IPX');
  assert.equal(world.FP[1], 'Confort');
  app.stop();
});

test('r3: an unanswered write of ours may land for one request time after it left, no longer', async () => {
  const { app } = await setup({ config: v4() });
  // A guard taken back from /data, already confirmed, sees only what this process wrote last.
  app.lastWrites.set('fp1', { value: PILOT.COMFORT, sentAt: 1000, answered: false });
  assert.ok(app.mayLand('fp1', PILOT.OFF, 1000 + TIMINGS.requestTimeout - 1));
  assert.equal(app.mayLand('fp1', PILOT.OFF, 1000 + TIMINGS.requestTimeout), undefined);
  assert.equal(app.mayLand('fp1', PILOT.COMFORT, 1001), undefined, 'same value: not older');
  assert.equal(app.mayLand('fp2', PILOT.OFF, 1001), undefined);
  app.stop();
});

test('r3: once a read shows the Off past the time our cut command could land, a change is a change', async () => {
  const { app, world, act, wait, at, later } = await heating(5);
  world.FP[1] = 'Eco';
  // The Comfort is cut by the Off and never handled by this IPX.
  world.latency = (r) => (/SetFP01=0/.test(r.path) ? 2 * SECOND : 20);
  world.queue.push((r) =>
    /SetFP01=0/.test(r.path) ? { json: { product: 'IPX800_V4', status: 'Success' } } : undefined,
  );
  const [c, o] = await act(Promise.all([at(0, 0, PILOT.COMFORT), at(200, 0, PILOT.OFF)]));
  assert.match(c.error, /Envoyée, sans confirmation/);
  assert.equal(o.success, true, o.error);
  await wait(30 * SECOND);
  assert.ok(app.guards.has('fp1'), 'held');
  assert.equal(app.guards.get('fp1').stale, undefined, 'out of the way');
  later(0, () => (world.FP[1] = 'Confort'));
  await wait(20 * SECOND);
  assert.equal(app.guards.has('fp1'), false, 'released: changed on the IPX');
  assert.equal(world.FP[1], 'Confort');
  app.stop();
});

/** A first start that read the IPX (the pace kept in /data), then these guards in /data. */
const keptGuards = async (guards) => {
  const store = memoryStore();
  const first = await setup({ config: v4({ poll_interval: 300 }), store });
  await first.start();
  first.app.stop();
  store.data.guards = guards.map((code) => ({
    code,
    kind: 'pilot-wire',
    value: PILOT.OFF,
    resends: 0,
    confirmed: false,
  }));
  return { store, clock: first.clock };
};

test('r3 R5: Offs clicked before the configuration leave first at start, as clicks never cut by a later one', async () => {
  const { store, clock } = await keptGuards(['fp3']);
  const zones = [created('pilot-wire', 'fp1'), created('pilot-wire', 'fp2')];
  const world = fakeIpx();
  for (let n = 1; n <= 3; n += 1) world.FP[n] = 'Confort';
  let calls = 0;
  const { app, gladys, wait, act } = await setup({
    config: v4({ poll_interval: 300 }),
    devices: zones,
    world,
    store,
    clock,
    getConfig: async () => {
      calls += 1;
      if (calls <= 2) throw new Error('busy');
      return v4({ poll_interval: 300 });
    },
  });
  // The Off of fp1 takes 500 ms on the IPX; 100 ms into it, an Off is clicked on fp2.
  let second;
  world.latency = (r) => {
    if (/SetFP01=3/.test(r.path) && !second) {
      second = new Promise((res) => clock.timers.setTimeout(res, 100)).then(() =>
        gladys.fake.setValue(zones[1], zones[1].features[0], PILOT.OFF),
      );
    }
    return /SetFP01=3/.test(r.path) ? 500 : 20;
  };
  await app.onConnected(() => gladys.getConfig());
  const kept = await act(gladys.fake.setValue(zones[0], zones[0].features[0], PILOT.OFF));
  assert.match(kept.error, /envoyée dès sa lecture/);
  await wait(10 * SECOND);
  const ack = await act(second);
  const sent = world.writes().filter((w) => w.sentAt !== undefined);
  // The clicks first (the one adopted by the start, then the later one), then the /data guard.
  assert.deepEqual(leftWrites(world), ['SetFP01=3', 'SetFP02=3', 'SetFP03=3']);
  assert.ok(
    sent.every((w) => w.end !== undefined),
    'none cut',
  );
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.FP.slice(1, 4), ['Arret', 'Arret', 'Arret']);
  app.stop();
  app.clearConfigTimer();
});

test('r3: a guard sent again and cut by a click before it left goes right behind that click', async () => {
  const { store, clock } = await keptGuards(['fp2']);
  const zones = [created('pilot-wire', 'fp1'), created('pilot-wire', 'fp2')];
  const world = fakeIpx();
  world.FP[1] = 'Confort';
  world.FP[2] = 'Confort';
  // The first connection for fp2 takes 200 ms: the click on fp1 cuts it before it leaves.
  let slow = true;
  world.connectDelay = (r) => (/SetFP02/.test(r.path) && slow ? ((slow = false), 200) : 0);
  const { app, gladys, act } = await setup({
    config: v4({ poll_interval: 300 }),
    devices: zones,
    world,
    store,
    clock,
  });
  const t0 = clock.elapsed;
  app.connected(v4({ poll_interval: 300 }));
  const ack = await act(
    new Promise((r) => clock.timers.setTimeout(r, 50)).then(() =>
      gladys.fake.setValue(zones[0], zones[0].features[0], PILOT.OFF),
    ),
  );
  await act(new Promise((r) => clock.timers.setTimeout(r, 500)));
  assert.equal(world.writes()[0].sentAt, undefined, 'the first try of fp2 never left');
  const fp2 = world.writes().find((w) => /SetFP02=3/.test(w.path) && w.sentAt !== undefined);
  assert.ok(fp2, 'the guard of fp2 left');
  assert.ok(fp2.sentAt - t0 < SECOND, `left ${fp2.sentAt - t0} ms after the start`);
  assert.equal(world.FP[2], 'Arret');
  assert.equal(ack.success, true, ack.error);
  app.stop();
});

test('r3: a guard cut before it left by a newer click on its own target is not tried again', async () => {
  const { store, clock } = await keptGuards(['fp2']);
  const zone = created('pilot-wire', 'fp2');
  const world = fakeIpx();
  world.FP[2] = 'Confort';
  world.connectDelay = (r) => (/SetFP02=3/.test(r.path) ? 200 : 0);
  const { app, gladys, act } = await setup({
    config: v4({ poll_interval: 300 }),
    devices: [zone],
    world,
    store,
    clock,
  });
  app.connected(v4({ poll_interval: 300 }));
  const ack = await act(
    new Promise((r) => clock.timers.setTimeout(r, 50)).then(() =>
      gladys.fake.setValue(zone, zone.features[0], PILOT.FROST_PROTECTION),
    ),
  );
  await act(new Promise((r) => clock.timers.setTimeout(r, 500)));
  assert.equal(world.writes().filter((w) => /SetFP02=3/.test(w.path)).length, 1, 'one try');
  assert.deepEqual(leftWrites(world), ['SetFP02=2']);
  assert.equal(world.FP[2], 'Hors Gel');
  assert.equal(ack.success, true, ack.error);
  app.stop();
});
