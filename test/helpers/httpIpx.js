// -----------------------------------------------------------------------------
// A fake IPX800 V4 or V5 on a REAL local HTTP server (127.0.0.1, the kit's
// httpServer), for the scenarios on a real clock: two of them stand for two
// boxes of one house. The V5 answers `system/info` with its MAC address (as
// pypx800v5 reads it: `macAdress`), `system/ipx`, `ebx/<type>`, `core/io`,
// `core/ana` and `PUT core/io/<id>`; the V4 answers `/api/xdevices.json`
// (`Get=all`, `SetR`, `ClearR`, `SetFPxx`). Any other path is a 404, as an
// IPX800 of the other model would answer. Every write is recorded.
// -----------------------------------------------------------------------------

import { httpServer, reply } from '../kit/index.mjs';
import { V5 } from './fakeIpx.js';

const FP_TEXT = ['Confort', 'Eco', 'Hors Gel', 'Arret', 'Confort -1', 'Confort -2'];
const FP_FIELDS = [
  'ioComfort_id',
  'ioEco_id',
  'ioAntiFreeze_id',
  'ioStop_id',
  'ioComfort_1_id',
  'ioComfort_2_id',
];

/** `{ srv, state, writes(), address }`: close with `srv.close()`. */
export async function httpIpx({
  version = 'v5',
  key = 'k',
  mac = '00:04:a3:12:34:56',
  latencyMs = 3,
  info = true,
} = {}) {
  const state = {
    version,
    key,
    mac,
    /** false: `system/info` answers 404 (an older firmware, say). */
    info,
    R: Array(57).fill(0),
    D: Array(57).fill(0),
    FP: Array(17).fill('Arret'),
    io: new Map(),
    ana: new Map([
      [400, 21.5],
      [401, 45],
      [402, 300],
    ]),
    layout: structuredClone(V5),
    writes: [],
  };
  for (const id of [...V5.ipx.ioRelays_id, ...V5.ipx.ioRelayState_id, ...V5.ipx.ioDInput_id]) {
    state.io.set(id, false);
  }
  for (const ext of V5.x8r) {
    for (const id of [...ext.ioOutput_id, ...ext.ioOutputState_id]) state.io.set(id, false);
  }
  for (const ext of V5.x4fp) {
    for (const field of FP_FIELDS) for (const id of ext[field]) state.io.set(id, false);
    for (const id of ext.ioStop_id) state.io.set(id, true);
  }
  const v4 = (r) => {
    if (r.query.key !== state.key) return reply(401, { status: 'Error' });
    const ok = { product: 'IPX800_V4', status: 'Success' };
    if (r.query.Get === 'all' || r.query.Get === 'R') {
      const out = { ...ok };
      for (let n = 1; n <= 56; n += 1) {
        out[`R${n}`] = state.R[n];
        if (r.query.Get === 'all') out[`D${n}`] = state.D[n];
      }
      if (r.query.Get === 'all') {
        for (let n = 1; n <= 16; n += 1) {
          out[`FP${Math.floor((n - 1) / 4) + 1} Zone ${((n - 1) % 4) + 1}`] = state.FP[n];
        }
      }
      return out;
    }
    for (const [name, value] of Object.entries(r.query)) {
      if (name === 'SetR' || name === 'ClearR') {
        state.writes.push(`${name}=${value}`);
        state.R[Number(value)] = name === 'SetR' ? 1 : 0;
        return ok;
      }
      const m = /^SetFP(\d{2})$/.exec(name);
      if (m) {
        state.writes.push(`${name}=${value}`);
        state.FP[Number(m[1])] = FP_TEXT[Number(value)];
        return ok;
      }
    }
    return { product: 'IPX800_V4', status: 'Error' };
  };
  const v5 = (r) => {
    if (r.query.ApiKey !== state.key) return reply(401, { error: 'unauthorized' });
    const path = r.path.replace(/^\/api\//, '');
    if (r.method === 'GET') {
      if (path === 'system/info') {
        return state.info
          ? { macAdress: state.mac, firmwareVersion: '5.4.4', hostName: 'IPX800V5' }
          : reply(404, 'not found');
      }
      if (path === 'system/ipx') return state.layout.ipx;
      const ebx = /^ebx\/(\w+)$/.exec(path);
      if (ebx) return state.layout[ebx[1]] ?? [];
      if (path === 'core/io') return [...state.io].map(([_id, on]) => ({ _id, on }));
      if (path === 'core/ana') return [...state.ana].map(([_id, value]) => ({ _id, value }));
      return reply(404, 'not found');
    }
    const m = /^core\/io\/(\d+)$/.exec(path);
    if (r.method === 'PUT' && m && typeof r.json?.on === 'boolean') {
      const id = Number(m[1]);
      if (!state.io.has(id)) return reply(404, {});
      state.writes.push(`io${id}=${r.json.on}`);
      state.io.set(id, r.json.on);
      const relay = state.layout.ipx.ioRelays_id.indexOf(id);
      if (relay >= 0) state.io.set(state.layout.ipx.ioRelayState_id[relay], r.json.on);
      for (const ext of state.layout.x4fp) {
        for (const field of FP_FIELDS) {
          const z = ext[field].indexOf(id);
          if (z >= 0 && r.json.on) {
            for (const other of FP_FIELDS) state.io.set(ext[other][z], other === field);
          }
        }
      }
      return { _id: id, on: r.json.on };
    }
    return reply(400, {});
  };
  const route = (r) => {
    if (r.path === '/api/xdevices.json') return state.version === 'v4' ? v4(r) : undefined;
    if (r.path.startsWith('/api/')) return state.version === 'v5' ? v5(r) : undefined;
    return undefined;
  };
  const srv = await httpServer({ latencyMs, routes: {} });
  // Every path through one handler (the kit matches exact paths only).
  srv.routes = new Proxy({}, { get: () => route });
  return {
    srv,
    state,
    address: `127.0.0.1:${srv.port}`,
    writes: () => [...state.writes],
  };
}
