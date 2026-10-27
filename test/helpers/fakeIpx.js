// -----------------------------------------------------------------------------
// A fake IPX800 (V4 or V5) behind the transport of the client (no network),
// on the virtual clock of the tests: each request takes `latency` ms of that
// clock (a timer), can be cut (onStart), times out at its deadline, applies
// a write when it is received, and records everything. It also counts the
// requests in flight at once (`peak`): the lane must keep it at 1.
//
// V4: GET /api/xdevices.json?key=<key>&Get=all | SetR=NN | ClearR=NN | SetFPNN=c
// V5: GET system/ipx, ebx/<type>, core/io, core/ana; PUT core/io/<id> { on }
// -----------------------------------------------------------------------------

import { IpxError } from '../../src/ipx/http.js';

export const KEY = 'S3cretKey-42';

const FP_TEXT = ['Confort', 'Eco', 'Hors Gel', 'Arret', 'Confort -1', 'Confort -2'];

/** V5 layout: the IPX relays 100-107 (states 110-117), inputs 120-127, an X-8R, an X-4FP, an X-THL. */
export const V5 = {
  ipx: {
    ioRelays_id: [100, 101, 102, 103, 104, 105, 106, 107],
    ioRelayState_id: [110, 111, 112, 113, 114, 115, 116, 117],
    ioDInput_id: [120, 121, 122, 123, 124, 125, 126, 127],
  },
  x8r: [
    {
      _id: 12,
      name: 'Garage',
      ioOutput_id: [200, 201, 202, 203, 204, 205, 206, 207],
      ioOutputState_id: [210, 211, 212, 213, 214, 215, 216, 217],
    },
  ],
  x4fp: [
    {
      _id: 7,
      name: 'Chauffage',
      ioComfort_id: [300, 301, 302, 303],
      ioEco_id: [304, 305, 306, 307],
      ioAntiFreeze_id: [308, 309, 310, 311],
      ioStop_id: [312, 313, 314, 315],
      ioComfort_1_id: [316, 317, 318, 319],
      ioComfort_2_id: [320, 321, 322, 323],
    },
  ],
  xthl: [{ _id: 9, name: 'Salon', anaTemp_id: 400, anaHum_id: 401, anaLum_id: 402 }],
};

const FP_FIELDS = [
  'ioComfort_id',
  'ioEco_id',
  'ioAntiFreeze_id',
  'ioStop_id',
  'ioComfort_1_id',
  'ioComfort_2_id',
];

export function fakeIpx({ version = 'v4', key = KEY } = {}) {
  const world = {
    version,
    key,
    requests: [],
    inFlight: 0,
    peak: 0,
    /** ms of the virtual clock per request, or a function of the request. */
    latency: 20,
    /** Answers to give first: an IpxError | { status, json } | (req) => answer | undefined. */
    queue: [],
    /** Writes accepted but not applied (the IPX answers Success, nothing changes). */
    ignoreWrites: false,
    /** Connections refused before anything leaves, for this many requests. */
    refuseConnect: 0,
    clock: undefined,
    // V4 state.
    R: Array(57).fill(0),
    D: Array(57).fill(0),
    FP: Array(17).fill('Arret'),
    THL: { 1: { TEMP: 21.5, HUM: 45, LUM: 300 } },
    // V5 state.
    io: new Map(),
    ana: new Map([
      [400, 21.5],
      [401, 45],
      [402, 300],
    ]),
    layout: structuredClone(V5),
    /** Every read (not the writes) answers this status when set. */
    failReads: undefined,
    /** V5 lists that fail: `ebx/x8r` -> status. */
    failPaths: new Map(),
    sleep(ms) {
      return new Promise((resolve) => world.clock.timers.setTimeout(resolve, ms));
    },
    transport: (options, hooks) => transport(world, options, hooks),
    writes() {
      return world.requests.filter((r) => /Set|Clear/.test(r.path) || r.method === 'PUT');
    },
    reads() {
      return world.requests.filter((r) => !/Set|Clear/.test(r.path) && r.method !== 'PUT');
    },
  };
  for (const id of [...V5.ipx.ioRelays_id, ...V5.ipx.ioRelayState_id, ...V5.ipx.ioDInput_id]) {
    world.io.set(id, false);
  }
  for (const ext of V5.x8r) {
    for (const id of [...ext.ioOutput_id, ...ext.ioOutputState_id]) world.io.set(id, false);
  }
  for (const ext of V5.x4fp) {
    for (const field of FP_FIELDS) for (const id of ext[field]) world.io.set(id, false);
    for (const id of ext.ioStop_id) world.io.set(id, true);
  }
  return world;
}

const json = (body, status = 200) => ({ status, body: Buffer.from(JSON.stringify(body), 'utf8') });

async function transport(world, options, { monotonic, deadline, beforeSend, onSent, onStart }) {
  const record = {
    method: options.method,
    path: options.path,
    body: options.body,
    at: monotonic(),
  };
  world.requests.push(record);
  world.inFlight += 1;
  world.peak = Math.max(world.peak, world.inFlight);
  let sent = false;
  let cut;
  const cutPromise = new Promise((_, reject) => {
    cut = () => reject(new IpxError('cut', 'cut by a protective command', { sent }));
  });
  cutPromise.catch(() => {});
  onStart?.(() => cut());
  try {
    if (deadline !== undefined && monotonic() >= deadline) {
      throw new IpxError('late', 'no time left to send');
    }
    if (world.refuseConnect > 0) {
      world.refuseConnect -= 1;
      throw new IpxError('network', 'connection refused', { reason: 'ECONNREFUSED' });
    }
    beforeSend?.();
    if (deadline !== undefined && monotonic() >= deadline) {
      throw new IpxError('late', 'no time left to send');
    }
    sent = true;
    onSent?.();
    record.sentAt = monotonic();
    const latency = typeof world.latency === 'function' ? world.latency(record) : world.latency;
    const left = deadline === undefined ? Infinity : deadline - monotonic();
    const answer = respond(world, record);
    if (latency > 0 || left < Infinity) {
      const outcome = await Promise.race([
        world.sleep(Math.min(latency, left)).then(() => (latency >= left ? 'timeout' : 'ok')),
        cutPromise,
      ]);
      if (outcome === 'timeout') {
        throw new IpxError('timeout', 'no answer in time', { sent: true });
      }
    }
    record.end = monotonic();
    if (answer instanceof Error) throw answer;
    return answer;
  } finally {
    world.inFlight -= 1;
  }
}

function respond(world, record) {
  let next = world.queue.shift();
  if (typeof next === 'function') next = next(record);
  if (next instanceof Error) return next;
  if (next) return json(next.json ?? {}, next.status ?? 200);
  const url = new URL(record.path, 'http://ipx');
  const write = record.method === 'PUT' || /Set|Clear/.test(record.path);
  if (world.failReads && !write) return json({}, world.failReads);
  if (world.version === 'v4') {
    if (url.pathname !== '/api/xdevices.json') return json({}, 404);
    if (url.searchParams.get('key') !== world.key) return json({ status: 'Error' }, 401);
    return v4(world, url.searchParams);
  }
  if (url.searchParams.get('ApiKey') !== world.key) return json({ error: 'unauthorized' }, 401);
  const path = url.pathname.replace(/^\/api\//, '');
  if (world.failPaths.has(path)) return json({}, world.failPaths.get(path));
  return v5(world, record.method, path, record.body);
}

function v4(world, params) {
  const ok = { product: 'IPX800_V4', status: 'Success' };
  if (params.get('Get') === 'all') {
    const out = { ...ok };
    for (let n = 1; n <= 56; n += 1) {
      out[`R${n}`] = world.R[n];
      out[`D${n}`] = world.D[n];
    }
    for (let n = 1; n <= 16; n += 1) {
      out[`FP${Math.floor((n - 1) / 4) + 1} Zone ${((n - 1) % 4) + 1}`] = world.FP[n];
    }
    for (const [n, thl] of Object.entries(world.THL)) {
      out[`THL${n}-TEMP`] = thl.TEMP;
      out[`THL${n}-HUM`] = thl.HUM;
      out[`THL${n}-LUM`] = thl.LUM;
    }
    return json(out);
  }
  for (const [name, value] of params) {
    let m;
    if (name === 'SetR' || name === 'ClearR') {
      if (!world.ignoreWrites) world.R[Number(value)] = name === 'SetR' ? 1 : 0;
      return json(ok);
    }
    if ((m = /^SetFP(\d{2})$/.exec(name))) {
      if (!world.ignoreWrites) world.FP[Number(m[1])] = FP_TEXT[Number(value)];
      return json(ok);
    }
  }
  return json({ product: 'IPX800_V4', status: 'Error' });
}

function v5(world, method, path, body) {
  const layout = world.layout;
  if (method === 'GET') {
    if (path === 'system/ipx') return json(layout.ipx);
    const ebx = /^ebx\/(\w+)$/.exec(path);
    if (ebx) return json(layout[ebx[1]] ?? []);
    if (path === 'core/io')
      return json([...world.io].map(([_id, on]) => ({ _id, name: `io ${_id}`, on })));
    if (path === 'core/ana') return json([...world.ana].map(([_id, value]) => ({ _id, value })));
    return json({}, 404);
  }
  const m = /^core\/io\/(\d+)$/.exec(path);
  if (method === 'PUT' && m && typeof body?.on === 'boolean') {
    const id = Number(m[1]);
    if (!world.io.has(id)) return json({}, 404);
    if (!world.ignoreWrites) applyV5(world, id, body.on);
    return json({ _id: id, on: body.on });
  }
  return json({}, 400);
}

function applyV5(world, id, on) {
  world.io.set(id, on);
  const relay = world.layout.ipx.ioRelays_id.indexOf(id);
  if (relay >= 0) world.io.set(world.layout.ipx.ioRelayState_id[relay], on);
  for (const ext of world.layout.x8r) {
    const k = ext.ioOutput_id.indexOf(id);
    if (k >= 0) world.io.set(ext.ioOutputState_id[k], on);
  }
  for (const ext of world.layout.x4fp) {
    for (const field of FP_FIELDS) {
      const z = ext[field].indexOf(id);
      if (z >= 0 && on) {
        // One mode per zone: the others go off.
        for (const other of FP_FIELDS) world.io.set(ext[other][z], other === field);
      }
    }
  }
}

/** The V5 mode IO of a zone of the X-4FP 7 that is on. */
export function v5Mode(world, zone) {
  const ext = world.layout.x4fp[0];
  return FP_FIELDS.find((field) => world.io.get(ext[field][zone - 1]));
}

/** Sets the V5 mode of a zone directly (as the IPX's own page would). */
export function setV5Mode(world, zone, field) {
  applyV5(world, world.layout.x4fp[0][field][zone - 1], true);
}
