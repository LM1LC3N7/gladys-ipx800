import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  normalizeConfig,
  parseAddress,
  parseApiKey,
  parseRelays,
  parseV4Extensions,
  sessionKey,
} from '../src/config.js';

test('addresses: IP, name, port; a pasted URL with the key, https, broadcast refused', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 80 });
  assert.deepEqual(parseAddress('http://ipx800.lan:8080/'), { host: 'ipx800.lan', port: 8080 });
  assert.deepEqual(parseAddress('http://192.168.1.50/api/xdevices.json?key=abc'), {
    error: 'path',
  });
  assert.deepEqual(parseAddress('https://192.168.1.50'), { error: 'https' });
  assert.deepEqual(parseAddress('255.255.255.255'), { error: 'invalid' });
  assert.deepEqual(parseAddress('224.0.0.1'), { error: 'invalid' });
  assert.deepEqual(parseAddress('0.0.0.0'), { error: 'invalid' });
  assert.deepEqual(parseAddress(''), {});
});

test('API key: printable, no space, no control character', () => {
  assert.equal(parseApiKey(' abc-123 '), 'abc-123');
  assert.equal(parseApiKey(''), '');
  assert.equal(parseApiKey(undefined), '');
  assert.equal(parseApiKey('ab\r\nX-Evil: 1'), null);
  assert.equal(parseApiKey('a b'), null);
  assert.equal(parseApiKey('x'.repeat(129)), null);
});

test('relays Gladys may drive: V4 1-56, V5 1-8 and X-8R; kinds switch or light; errors reported', () => {
  const v4 = parseRelays('R1, 3:light; r56\nR57, X8R12-1, R2:pump', 'v4');
  assert.deepEqual(
    [...v4.relays],
    [
      ['r1', 'switch'],
      ['r3', 'light'],
      ['r56', 'switch'],
    ],
  );
  assert.deepEqual(v4.errors, ['R57', 'X8R12-1', 'R2:pump']);
  const v5 = parseRelays('R8, x8r12-3:light, R9, X8R12-9', 'v5');
  assert.deepEqual(
    [...v5.relays],
    [
      ['r8', 'switch'],
      ['x8r12-3', 'light'],
    ],
  );
  assert.deepEqual(v5.errors, ['R9', 'X8R12-9']);
});

test('V4 extensions: ranges by prefix, bounded', () => {
  const { codes, errors } = parseV4Extensions(
    'R9-R16, D9-24, FP1-FP4, THL1, R12, FP17, R9-D10, D5-D2',
  );
  assert.equal(codes.size, 8 + 16 + 4 + 1);
  assert.ok(codes.has('r16') && codes.has('d24') && codes.has('fp4') && codes.has('thl1'));
  assert.deepEqual(errors, ['FP17', 'R9-D10', 'D5-D2']);
});

test('defaults: V5, heating modes off; a session is the version, address, port and key', () => {
  const config = normalizeConfig({});
  assert.equal(config.version, DEFAULTS.version);
  assert.equal(config.allowHeatingModes, false);
  assert.equal(config.pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 5);
  assert.equal(normalizeConfig({ allow_heating_modes: 'yes' }).allowHeatingModes, false);
  const a = normalizeConfig({ host: '10.0.0.2', api_key: 'k1' });
  const b = normalizeConfig({ host: '10.0.0.2', api_key: 'k1', relays: 'R1' });
  const c = normalizeConfig({ host: '10.0.0.2', api_key: 'k2' });
  assert.equal(sessionKey(a), sessionKey(b));
  assert.notEqual(sessionKey(a), sessionKey(c));
  assert.equal(normalizeConfig({ host: '10.0.0.2:8080', port: 80 }).port, 8080);
  assert.equal(normalizeConfig({ host: '10.0.0.2', port: 8081 }).port, 8081);
  assert.ok(!a.key.includes('k1'));
});
