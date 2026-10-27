// -----------------------------------------------------------------------------
// The client and its HTTP layer against a real local HTTP server (the shared
// kit): the key in the query only, never in an error; bounded answers; a
// protective request cuts a slow read and opens its connection once the
// read's is closed; one request at a time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { IpxClient, PRIORITY } from '../src/ipx/client.js';
import { IpxError, errorReason } from '../src/ipx/http.js';
import { httpServer, reply } from './kit/index.mjs';

const KEY = 'K3y-Secret';

const client = (port, version = 'v4') =>
  new IpxClient({ version, host: '127.0.0.1', port, apiKey: KEY });

test('V4: Get=all with the key in the query, JSON asked; a write needs "Success"', async (t) => {
  const srv = await httpServer({
    routes: {
      'GET /api/xdevices.json': (r) =>
        r.query.Get === 'all' ? { status: 'Success', R1: 1 } : { status: 'Error' },
    },
  });
  t.after(() => srv.close());
  const c = client(srv.port);
  const json = await c.v4ReadAll();
  assert.equal(json.R1, 1);
  assert.equal(srv.requests[0].query.key, KEY);
  assert.match(srv.requests[0].headers.accept, /application\/json/);
  await assert.rejects(c.v4Write('SetR=01', PRIORITY.COMMAND), (err) => {
    assert.equal(err.code, 'not_success');
    assert.equal(err.sent, true);
    return true;
  });
  await assert.rejects(c.v4Write('SetR=01&Reset=1', PRIORITY.COMMAND), { code: 'bad_request' });
  assert.equal(srv.requests.length, 2, 'an invalid write never leaves');
});

test('V5: PUT core/io/<id> with { on }, the key in the query', async (t) => {
  const srv = await httpServer({
    routes: { 'PUT /api/core/io/312': (r) => ({ _id: 312, ...r.json }) },
  });
  t.after(() => srv.close());
  await client(srv.port, 'v5').v5Write(312, true, PRIORITY.PROTECTIVE);
  assert.deepEqual(srv.requests[0].json, { on: true });
  assert.equal(srv.requests[0].query.ApiKey, KEY);
});

test('statuses: 401 refused, 503 busy, 500 http, a text not JSON; the key and address never in a message', async (t) => {
  const srv = await httpServer({
    routes: {
      '/api/core/io': reply(401, { error: 'unauthorized' }),
      '/api/core/ana': reply(500, 'oops'),
      '/api/system/ipx': 'not json at all',
    },
  });
  t.after(() => srv.close());
  const c = client(srv.port, 'v5');
  const errors = [];
  for (const call of [() => c.v5Io(), () => c.v5Ana(), () => c.v5Ipx()]) {
    errors.push(await call().catch((err) => err));
  }
  srv.status5xx = 1;
  errors.push(await c.v5Io().catch((err) => err));
  assert.deepEqual(
    errors.map((e) => e.code),
    ['refused', 'http', 'bad_response', 'busy'],
  );
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  errors.push(
    await client(port)
      .v4ReadAll()
      .catch((err) => err),
  );
  assert.equal(errors.at(-1).code, 'network');
  assert.equal(errors.at(-1).sent, false);
  for (const err of errors) {
    const text = `${err.message} ${errorReason(err)} ${err.stack}`;
    assert.ok(!text.includes(KEY), text);
    assert.ok(!text.includes('127.0.0.1'), text);
  }
});

test('an answer over the limit is cut before it is read whole', async (t) => {
  const srv = await httpServer({
    routes: { '/api/xdevices.json': { status: 'Success' } },
    bigBody: 200_000,
  });
  t.after(() => srv.close());
  await assert.rejects(client(srv.port).v4ReadAll(), { code: 'size' });
});

test('a silent IPX: timeout at the deadline, "sent"', async (t) => {
  const srv = await httpServer({ routes: { '/api/xdevices.json': 'silent' } });
  t.after(() => srv.close());
  const c = client(srv.port);
  const started = performance.now();
  const err = await c
    .v4ReadAll(PRIORITY.READ, { deadline: performance.now() + 300 })
    .catch((e) => e);
  assert.equal(err.code, 'timeout');
  assert.equal(err.sent, true);
  assert.ok(performance.now() - started < 1500);
});

test('a protective request cuts a slow read, after its connection is closed; one request at a time', async (t) => {
  let open = 0;
  let peak = 0;
  const srv = await httpServer({
    latencyMs: (r) => (r.query.Get === 'all' ? 5000 : 10),
    routes: { '/api/xdevices.json': { status: 'Success' } },
  });
  t.after(() => srv.close());
  const c = new IpxClient({
    version: 'v4',
    host: '127.0.0.1',
    port: srv.port,
    apiKey: KEY,
    // Counts the requests open at once, from the client side (open -> settled).
    transport: async (options, hooks) => {
      const { request } = await import('../src/ipx/http.js');
      open += 1;
      peak = Math.max(peak, open);
      try {
        return await request(options, hooks);
      } finally {
        open -= 1;
      }
    },
  });
  const read = c.v4ReadAll(PRIORITY.READ, { deadline: performance.now() + 10_000 }).catch((e) => e);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = performance.now();
  await c.v4Write('SetFP01=3', PRIORITY.PROTECTIVE);
  const took = performance.now() - started;
  const err = await read;
  assert.ok(err instanceof IpxError);
  assert.equal(err.code, 'cut');
  assert.ok(took < 1000, `the protective write took ${Math.round(took)} ms`);
  assert.equal(peak, 1, 'never two requests open at once');
  assert.equal(srv.requests.length, 2);
});

test('a server keeping the connection open: one connection at a time, the next opened after', async (t) => {
  const { tcpServer } = await import('./kit/index.mjs');
  const text = JSON.stringify({ status: 'Success', R1: 0 });
  const dev = await tcpServer({
    onData: (c) =>
      c.toString('latin1').startsWith('GET')
        ? `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${text.length}\r\n\r\n${text}`
        : undefined,
  });
  t.after(() => dev.close());
  const c = client(dev.port);
  await c.v4ReadAll();
  await c.v4ReadAll();
  await Promise.all([
    c.v4Write('ClearR=01', PRIORITY.PROTECTIVE).catch(() => {}),
    c.v4Write('ClearR=02', PRIORITY.PROTECTIVE).catch(() => {}),
    c.v4ReadAll().catch(() => {}),
  ]);
  assert.equal(dev.connections, 5);
  assert.equal(dev.peak, 1, 'never two connections open at once');
});

test('the lane waits a little after a request before opening the next connection', async () => {
  const { testClock } = await import('./kit/index.mjs');
  const { TIMINGS } = await import('../src/constants.js');
  const clock = testClock();
  const started = [];
  const c = new IpxClient({
    version: 'v4',
    host: '127.0.0.1',
    port: 1,
    apiKey: KEY,
    monotonic: clock.monotonic,
    timers: clock.timers,
    transport: async () => {
      started.push(clock.elapsed);
      return { status: 200, body: Buffer.from('{"status":"Success"}') };
    },
  });
  const both = Promise.all([c.v4ReadAll(), c.v4ReadAll()]);
  await clock.advance(1);
  await clock.advance(TIMINGS.laneGap / 2);
  assert.equal(started.length, 1, 'the second waits');
  await clock.advance(TIMINGS.laneGap);
  await both;
  assert.equal(started.length, 2);
  assert.ok(started[1] - started[0] >= TIMINGS.laneGap);
});
