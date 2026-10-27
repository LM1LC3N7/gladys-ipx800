// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), sped
// up 20 times, against a real local HTTP server playing an IPX800 V4: the
// rounds start at the interval, never sooner, never a cycle late; a command
// still reads back and resolves. The real clock moves between any two reads.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IpxApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { httpServer, measurePeriod, realClock, spyOn } from './kit/index.mjs';

const SPEED = 20;
const INTERVAL = POLL_INTERVAL.default * 1000;

test('real clock x20: one round per interval (measured), a command confirmed', async (t) => {
  const R = Array(57).fill(0);
  const srv = await httpServer({
    latencyMs: 5,
    routes: {
      '/api/xdevices.json': (r) => {
        if (r.query.key !== 'k') return { status: 'Error' };
        if (r.query.SetR) R[Number(r.query.SetR)] = 1;
        const out = { status: 'Success' };
        for (let n = 1; n <= 56; n += 1) {
          out[`R${n}`] = R[n];
          out[`D${n}`] = 0;
        }
        return out;
      },
    },
  });
  const clock = realClock({ speed: SPEED });
  // Registered first, run last (t.after runs in reverse order).
  t.after(async () => {
    clock.close();
    await srv.close();
  });
  const gladys = createFakeGladys({ selector: 'ipx', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new IpxApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const spy = spyOn(app, 'readRound', clock);
  await app.connected({ version: 'v4', host: `127.0.0.1:${srv.port}`, api_key: 'k', relays: 'R1' });
  const gaps = await measurePeriod(spy, { count: 4, period: INTERVAL });
  assert.equal(gaps.length, 3);
  const feature = { external_id: 'ext:ipx:relay:r1:switch' };
  const ack = await gladys.fake.setValue({ external_id: 'ext:ipx:relay:r1' }, feature, 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(R[1], 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  app.stop();
  assert.ok(clock.timersSet < 40, `${clock.timersSet} timers`);
});
