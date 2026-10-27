import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILOT } from '../src/constants.js';
import {
  parseV4,
  parseV5Layout,
  parseV5Values,
  v4Codes,
  v4WriteQuery,
  v4ZoneKey,
  v5FromKept,
  v5Value,
  v5Write,
} from '../src/ipx/model.js';
import { V5 } from './helpers/fakeIpx.js';

test('V4: the answer must say "Success"; values strict (no text, no null as 0)', () => {
  assert.deepEqual(parseV4({ status: 'Error' }, ['r1']), { error: 'not_success' });
  assert.deepEqual(parseV4([], ['r1']), { error: 'bad_response' });
  const { targets } = parseV4(
    {
      status: 'Success',
      R1: 1,
      R2: '1',
      D1: null,
      'FP1 Zone 2': 'Hors Gel',
      'FP2 Zone 1': '',
      'THL1-TEMP': 19.5,
      'THL1-HUM': 'n/a',
    },
    ['r1', 'r2', 'd1', 'fp2', 'fp5', 'thl1', 'zz9'],
  );
  assert.equal(targets.get('r1').value, 1);
  assert.equal(targets.get('r2').value, undefined);
  assert.equal(targets.get('d1').value, undefined);
  assert.equal(targets.get('fp2').value, PILOT.FROST_PROTECTION);
  assert.equal(targets.get('fp5').value, undefined);
  assert.deepEqual(targets.get('thl1').value, {
    temperature: 19.5,
    humidity: undefined,
    luminosity: undefined,
  });
  assert.ok(!targets.has('zz9'));
  assert.equal(v4ZoneKey(16), 'FP4 Zone 4');
});

test('V4: the listed targets and the write queries', () => {
  const codes = v4Codes(new Set(['fp1']), new Map([['r20', 'switch']]));
  assert.ok(codes.has('r8') && codes.has('d8') && codes.has('fp1') && codes.has('r20'));
  assert.ok(!codes.has('r9'));
  assert.equal(v4WriteQuery({ kind: 'relay', n: 3 }, 1), 'SetR=03');
  assert.equal(v4WriteQuery({ kind: 'relay', n: 13 }, 0), 'ClearR=13');
  assert.equal(v4WriteQuery({ kind: 'pilot-wire', n: 5 }, PILOT.OFF, 3), 'SetFP05=3');
  assert.equal(v4WriteQuery({ kind: 'input', n: 1 }, 1), undefined);
});

test('V5: layout, values, one mode per zone or unknown; a key "__proto__" pollutes nothing', () => {
  const extensions = new Map([
    ['x8r', V5.x8r],
    ['x4fp', V5.x4fp],
    ['xthl', V5.xthl],
    ['x8d', JSON.parse('[{"_id": 3, "__proto__": {"polluted": 1}, "ioInput_id": [1,2,3]}]')],
  ]);
  const { targets, types } = parseV5Layout(V5.ipx, extensions);
  assert.equal(targets.size, 8 + 8 + 8 + 4 + 1, 'the incomplete X-8D is left out');
  assert.ok(types.has('x8d'));
  assert.equal({}.polluted, undefined);
  const zone = targets.get('x4fp7-1');
  const io = [
    { _id: 312, on: true },
    ...[300, 304, 308, 316, 320].map((_id) => ({ _id, on: false })),
    { _id: 110, on: 'yes' },
  ];
  const values = parseV5Values(io, [
    { _id: 400, value: 20.5 },
    { _id: 401, value: '50' },
  ]);
  assert.equal(v5Value(zone, values), PILOT.OFF);
  assert.equal(v5Value(targets.get('r1'), values), undefined, '"yes" is not a boolean');
  assert.deepEqual(v5Value(targets.get('xthl9'), values), {
    temperature: 20.5,
    humidity: undefined,
    luminosity: undefined,
  });
  const two = parseV5Values(
    io.map((e) => (e._id === 300 ? { _id: 300, on: true } : e)),
    [],
  );
  assert.equal(v5Value(zone, two), undefined, 'two modes on: unknown');
  assert.deepEqual(v5Write(zone, PILOT.FROST_PROTECTION), { id: 308, on: true });
  assert.deepEqual(v5Write(targets.get('x8r12-2'), 0), { id: 201, on: false });
  assert.deepEqual(parseV5Values({ not: 'a list' }), { error: 'bad_response' });
});

test('V5: ids kept in /data are checked when read back', () => {
  assert.equal(v5FromKept('x4fp7-1', { kind: 'pilot-wire', io: { 0: 312 } }), undefined);
  assert.equal(v5FromKept('r1', { kind: 'relay', state: -1, command: 100 }), undefined);
  assert.equal(v5FromKept('d1', { kind: 'relay', state: 1, command: 100 }), undefined);
  assert.deepEqual(v5FromKept('r1', { kind: 'relay', state: 110, command: 100 }), {
    code: 'r1',
    kind: 'relay',
    state: 110,
    command: 100,
  });
});
