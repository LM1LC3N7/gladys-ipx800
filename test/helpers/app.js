// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake IPX800 and the virtual clock
// of the shared test kit: every read of `now()` or `monotonic()` moves the
// time by 1 µs, so a decision reading the clock twice is caught.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock } from '../kit/index.mjs';
import { IpxApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { KEY, fakeIpx } from './fakeIpx.js';

export const SELECTOR = 'ipx';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const START = Date.UTC(2026, 9, 27, 12, 0, 0);
export const ADDRESS = '192.168.1.50';
export const CONFIG = {
  v4: { version: 'v4', host: ADDRESS, api_key: KEY },
  v5: { version: 'v5', host: ADDRESS, api_key: KEY },
};

/** The external id of a feature: `F('relay', 'r3', 'switch')`. */
export const F = (kind, code, key) => `ext:${SELECTOR}:${kind}:${code}:${key}`;

/** A device as the user created it from the Discovery list. */
export function created(kind, code, { relayKind, extra = [] } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const n = Number(/(\d+)$/.exec(code)[1]);
  const device = buildDevice(gladys, { code, kind, n }, { language: 'fr', relayKind });
  for (const key of extra) {
    const more = buildDevice(gladys, { code, kind, n }, { language: 'fr', relayKind: key });
    device.features.push(...more.features);
  }
  return device;
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export async function setup({
  version = 'v4',
  config,
  devices = [],
  store,
  clock = testClock({ start: START }),
  world = fakeIpx({ version }),
  getConfig,
} = {}) {
  const cfg = config ?? CONFIG[version];
  const gladys = createFakeGladys({ selector: SELECTOR, config: cfg, devices });
  await gladys.connect();
  if (getConfig) gladys.getConfig = getConfig;
  world.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const kept = store ?? memoryStore();
  const app = new IpxApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    transport: world.transport,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: kept,
    random: () => '0123456789abcdef0123456789abcdef',
  });
  registerHandlers(gladys, app, { error: log });
  const start = async (raw = cfg) => {
    await app.connected(raw);
    await wait(1000);
  };
  async function wait(ms) {
    await clock.advance(ms);
    await settle();
  }
  /** Awaits a promise while the virtual clock moves (10 ms steps). */
  const act = async (promise, max = 30_000) => {
    let done = false;
    const result = promise.then(
      (value) => {
        done = true;
        return { value };
      },
      (error) => {
        done = true;
        return { error };
      },
    );
    await settle();
    for (let t = 0; !done && t < max; t += 10) {
      await clock.advance(10);
      await settle(3);
    }
    if (!done) throw new Error('the promise did not settle');
    const { value, error } = await result;
    if (error) throw error;
    return value;
  };
  /** A command through the fake Gladys; its ack awaited while the clock moves. */
  const cmd = (device, featureId, value) => {
    const feature = device.features.find((f) => f.external_id === featureId);
    return act(gladys.fake.setValue(device, feature ?? { external_id: featureId }, value));
  };
  /** The time since the start of the clock (ms). */
  const elapsed = () => clock.elapsed;
  return { app, gladys, clock, store: kept, world, start, wait, act, cmd, lines, elapsed };
}
