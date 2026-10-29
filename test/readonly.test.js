// -----------------------------------------------------------------------------
// After the first test on a real IPX800 V5 (forum, cce66): relays read only
// by default must say so, and say what to do (list them, then "Update" in
// Discovery); what the V5 API of the GCE tools showed (X-THL fault IO, large
// extension ids).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelays, relayCode } from '../src/config.js';
import { parseExternalId } from '../src/devices.js';
import { parseV5Layout, parseV5Values, v5Fault, v5Value, v5Write } from '../src/ipx/model.js';
import { V5, fakeIpx } from './helpers/fakeIpx.js';
import { CONFIG, F, SECOND, created, setup } from './helpers/app.js';

const message = (gladys, lang = 'en') => gladys.fake.connectionStatus?.message?.[lang] ?? '';
const discovered = (gladys, code) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === `ext:ipx:relay:${code}`);

// --- Read only, said in the status --------------------------------------------------

test('no relay listed: the status counts the relays read only and says where to list them', async () => {
  const { app, gladys, start } = await setup({ version: 'v5' });
  await start();
  assert.match(
    message(gladys),
    /16 relay\(s\) read only: list them in Configuration → Relays Gladys may drive to drive them\./,
  );
  assert.match(
    message(gladys, 'fr'),
    /16 relais en lecture seule : listez-les dans Configuration → Relais pilotables par Gladys pour les piloter\./,
  );
  // The safety rule is untouched: read only, no switch, no light.
  const relay = discovered(gladys, 'r1');
  assert.deepEqual(
    relay.features.map((f) => [f.external_id, f.read_only]),
    [[F('relay', 'r1', 'readonly'), true]],
  );
  assert.equal(relay.features[0].name, 'État (lecture seule, voir Relais pilotables par Gladys)');
  app.stop();
});

test('V4, nothing listed: the 8 relays of the IPX are said read only, in English too', async () => {
  const { app, gladys, start } = await setup({ config: { ...CONFIG.v4, language: 'en' } });
  await start();
  assert.match(message(gladys), /8 relay\(s\) read only/);
  assert.equal(
    discovered(gladys, 'r1').features[0].name,
    'State (read only, see Relays Gladys may drive)',
  );
  app.stop();
});

test('one relay listed: no "read only" hint any more (the others stay read only, silently)', async () => {
  const { app, gladys, start } = await setup({ config: { ...CONFIG.v4, relays: 'R1' } });
  await start();
  assert.doesNotMatch(message(gladys), /read only/);
  assert.doesNotMatch(message(gladys, 'fr'), /lecture seule/);
  assert.equal(discovered(gladys, 'r2').features[0].read_only, true);
  app.stop();
});

test('a relay listed but not found does not count as drivable: the hint stays', async () => {
  const { app, gladys, start } = await setup({
    version: 'v5',
    config: { ...CONFIG.v5, relays: 'X8R99-1' },
  });
  await start();
  assert.match(message(gladys), /16 relay\(s\) read only/);
  assert.match(message(gladys), /Relays declared but not found on the IPX800: X8R99-1\./);
  app.stop();
});

// --- Listed, waiting for "Update" in Discovery -----------------------------------------

test('relays listed after their creation: the status names those waiting for "Update", until it is done', async () => {
  const devices = [created('relay', 'r1'), created('relay', 'r2'), created('relay', 'r4')];
  const { app, gladys, start, wait } = await setup({ version: 'v5', devices });
  await start();
  assert.match(message(gladys), /16 relay\(s\) read only/);
  assert.doesNotMatch(message(gladys), /Update/);

  // cce66's case: R1, R2 listed (R2 as a light), R3 listed but never created.
  await gladys.fake.configUpdated({ ...CONFIG.v5, relays: 'R1, R2:light, R3' });
  await wait(SECOND);
  assert.doesNotMatch(message(gladys), /read only/);
  assert.match(
    message(gladys),
    /Relays listed, waiting for "Update" in Discovery to be driven: R1, R2\./,
  );
  assert.match(
    message(gladys, 'fr'),
    /Relais listés, en attente de « Mettre à jour » dans Découverte pour être pilotés : R1, R2\./,
  );
  // Discovery offers the new feature next to the old one (kept).
  assert.deepEqual(
    discovered(gladys, 'r1')
      .features.map((f) => f.external_id)
      .sort(),
    [F('relay', 'r1', 'readonly'), F('relay', 'r1', 'switch')],
  );

  // The user clicks "Update" on R1: Gladys sends the device updated.
  await gladys.fake.deviceUpdated(discovered(gladys, 'r1'));
  assert.match(message(gladys), /waiting for "Update" in Discovery to be driven: R2\./);
  await gladys.fake.deviceUpdated(discovered(gladys, 'r2'));
  assert.doesNotMatch(message(gladys), /Update/);

  // Deleting a relay device takes it out of the reckoning as well (nothing to update).
  await gladys.fake.configUpdated({ ...CONFIG.v5, relays: 'R1, R2:light, R4' });
  await wait(SECOND);
  assert.match(message(gladys), /waiting for "Update" in Discovery to be driven: R4\./);
  await gladys.fake.deviceDeleted(devices[2]);
  assert.doesNotMatch(message(gladys), /Update/);
  app.stop();
});

test('a relay updated in Discovery is drivable: its switch works', async () => {
  const before = created('relay', 'r1');
  const { app, gladys, start, wait, cmd, world } = await setup({
    version: 'v5',
    devices: [before],
  });
  await start();
  await gladys.fake.configUpdated({ ...CONFIG.v5, relays: 'R1' });
  await wait(SECOND);
  const updated = discovered(gladys, 'r1');
  await gladys.fake.deviceUpdated(updated);
  const ack = await cmd(updated, F('relay', 'r1', 'switch'), 1);
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.equal(world.io.get(V5.ipx.ioRelayState_id[0]), true);
  app.stop();
});

test('the status is not rewritten by a device event during a failure', async () => {
  const devices = [created('relay', 'r1')];
  const world = fakeIpx({ version: 'v5' });
  const { app, gladys, start, wait } = await setup({
    version: 'v5',
    world,
    config: { ...CONFIG.v5, relays: 'R1' },
    devices,
  });
  await start();
  assert.match(message(gladys), /waiting for "Update"/);
  world.failReads = 500;
  await wait(10 * SECOND);
  assert.match(message(gladys), /does not answer/);
  await gladys.fake.deviceUpdated({ ...devices[0] });
  assert.match(message(gladys), /does not answer/);
  app.stop();
});

// --- V5 API, from the GCE tools of cce66 ----------------------------------------------------

test('X-8R ids as large as the IPX gives them (4784128 in the GCE tools) can be listed', () => {
  assert.equal(relayCode('X8R4784128-3', 'v5'), 'x8r4784128-3');
  assert.equal(relayCode('x8r1000000000-8', 'v5'), 'x8r1000000000-8');
  assert.equal(relayCode('X8R1000000001-1', 'v5'), undefined, 'beyond what the layout takes');
  assert.equal(relayCode('X8R4784128-3', 'v4'), undefined);
  const { relays, errors } = parseRelays('X8R4784128-3:light', 'v5');
  assert.deepEqual([...relays], [['x8r4784128-3', 'light']]);
  assert.deepEqual(errors, []);
  // The same code the layout publishes, and an external id that parses back.
  const ext = { ...V5.x8r[0], _id: 4784128 };
  const { targets } = parseV5Layout(V5.ipx, new Map([['x8r', [ext]]]));
  assert.ok(targets.has('x8r4784128-3'));
  assert.deepEqual(parseExternalId('ext:ipx:relay:x8r4784128-3:light', 'ipx'), {
    kind: 'relay',
    code: 'x8r4784128-3',
    key: 'light',
  });
  assert.deepEqual(v5Write(targets.get('x8r4784128-3'), 0), { id: 202, on: false });
});

test('X-THL: its fault IO on gives no measurement; off, absent or unread changes nothing', () => {
  const thl = { ...V5.xthl[0], ioFault_id: 403 };
  const { targets } = parseV5Layout(V5.ipx, new Map([['xthl', [thl]]]));
  const target = targets.get('xthl9');
  assert.equal(target.faultIo, 403);
  const ana = [
    { _id: 400, value: 21.5 },
    { _id: 401, value: 45 },
    { _id: 402, value: 300 },
  ];
  const on = parseV5Values([{ _id: 403, on: true }], ana);
  assert.equal(v5Fault(target, on), true);
  assert.equal(v5Value(target, on), undefined);
  const off = parseV5Values([{ _id: 403, on: false }], ana);
  assert.equal(v5Fault(target, off), false);
  assert.equal(v5Value(target, off).temperature, 21.5);
  const unread = parseV5Values([], ana);
  assert.equal(v5Value(target, unread).temperature, 21.5, 'an IO not listed is no fault');
  for (const bad of ['403', -1, 1.5, null]) {
    const layout = parseV5Layout(V5.ipx, new Map([['xthl', [{ ...V5.xthl[0], ioFault_id: bad }]]]));
    assert.equal(layout.targets.get('xthl9').faultIo, undefined, String(bad));
  }
  const without = parseV5Layout(V5.ipx, new Map([['xthl', [V5.xthl[0]]]])).targets.get('xthl9');
  assert.equal(v5Value(without, on).humidity, 45);
});

test('X-THL in fault end to end: nothing published, the status names it, back once it clears', async () => {
  const world = fakeIpx({ version: 'v5' });
  world.layout.xthl[0].ioFault_id = 403;
  world.io.set(403, true);
  const { app, gladys, start, wait } = await setup({
    version: 'v5',
    world,
    devices: [created('thl', 'xthl9')],
  });
  await start();
  await app.flush();
  assert.equal(gladys.fake.lastState(F('thl', 'xthl9', 'temperature')), undefined);
  assert.match(
    message(gladys),
    /X-THL reporting a measurement fault, values not published: XTHL9\./,
  );
  assert.match(message(gladys, 'fr'), /X-THL en défaut de mesure, valeurs non publiées : XTHL9\./);
  world.io.set(403, false);
  await wait(10 * SECOND);
  await app.flush();
  assert.equal(gladys.fake.lastState(F('thl', 'xthl9', 'temperature')), 21.5);
  assert.doesNotMatch(message(gladys), /fault/);
  app.stop();
});
