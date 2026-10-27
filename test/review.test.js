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

test('B1: an Off not sent in time (behind another clicked Off) leaves as soon as the lane frees', async () => {
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
  const [, ack2] = await act(Promise.all([first, second]));
  assert.match(ack2.error, /Pas encore envoyée.*renvoyée dès que l’IPX800 est libre/);
  await act(new Promise((r) => clock.timers.setTimeout(r, 2 * SECOND)));
  const write = world.writes().find((w) => /SetFP02=3/.test(w.path) && w.sentAt !== undefined);
  assert.ok(write, 'SetFP02=3 written');
  assert.ok(write.sentAt - t0 < 5.5 * SECOND, `left at ${write.sentAt - t0} ms, before any read`);
  assert.equal(world.FP[2], 'Arret');
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
