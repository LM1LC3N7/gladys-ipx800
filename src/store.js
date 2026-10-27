// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), bounded and checked when read back:
//   - the time of the last read attempt (a restart never reads sooner);
//   - for the controller it belongs to (a hash of its version, address and
//     port), the pause after failed reads, the refused API key (a salted
//     8-bit tag, never the key), the V5 ids of the relays and pilot-wire
//     zones (a protective command can leave before the first read), and the
//     protective commands to send again (guards).
// Never the API key nor the address. A small JSON file, written through a
// temporary file and a rename, one save after the other, readable by the
// container user only (0600).
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/ipx800-state.json';
/** A larger file is not ours: refused (read bounded). */
const MAX_STATE_BYTES = 256 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** null when there is no file (a fresh install); throws when it cannot be read or parsed. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw err;
      }
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) {
        throw new Error('state file too large');
      }
      return JSON.parse(text);
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests). `fail`: the next saves throw; `unreadable`: load throws. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    fail: false,
    unreadable: false,
    async load() {
      if (this.unreadable) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      if (this.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
const isCode = (value) => typeof value === 'string' && /^[a-z0-9-]{2,24}$/.test(value);

/** A guard read back: `{ code, value, resends, confirmed, other }`; undefined when not valid. */
function guardOf(raw) {
  if (
    !isCode(raw?.code) ||
    !Number.isInteger(raw.value) ||
    raw.value < 0 ||
    raw.value > 5 ||
    (raw.kind !== 'relay' && raw.kind !== 'pilot-wire')
  ) {
    return undefined;
  }
  return {
    code: raw.code,
    kind: raw.kind,
    value: raw.value,
    resends: Number.isInteger(raw.resends) ? Math.min(Math.max(raw.resends, 0), 99) : 0,
    confirmed: raw.confirmed === true,
    other: Number.isInteger(raw.other) && raw.other >= 0 && raw.other <= 5 ? raw.other : undefined,
  };
}

/** An empty memory. */
export const emptyMemory = () => ({
  lastAttemptAt: null,
  key: '',
  pause: null,
  refused: null,
  layout: {},
  guards: [],
});

/**
 * The persisted state, repaired; dates in the future are brought to `now`
 * (wall clock), the end of a pause is capped from `now`, so a clock jump or
 * a hand-edited file never stops the reads for good.
 */
export function normalizeMemory(raw, now = Date.now()) {
  const memory = emptyMemory();
  const lastAttemptAt = time(raw?.lastAttemptAt);
  memory.lastAttemptAt = lastAttemptAt === undefined ? null : Math.min(lastAttemptAt, now);
  const key = typeof raw?.key === 'string' && /^[0-9a-f]{32}$/.test(raw.key) ? raw.key : '';
  if (!key) {
    return memory;
  }
  memory.key = key;
  const p = raw?.pause;
  if (p && typeof p === 'object' && time(p.until)) {
    memory.pause = {
      until: Math.min(p.until, now + TIMINGS.pauseMax),
      failures: Number.isInteger(p.failures) && p.failures >= 0 ? Math.min(p.failures, 10) : 0,
      code: p.code === 'busy' ? 'busy' : 'failed',
    };
  }
  const r = raw?.refused;
  if (
    r &&
    typeof r.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(r.salt) &&
    Number.isInteger(r.tag) &&
    r.tag >= 0 &&
    r.tag < 256
  ) {
    memory.refused = { salt: r.salt, tag: r.tag };
  }
  if (raw?.layout && typeof raw.layout === 'object' && !Array.isArray(raw.layout)) {
    let count = 0;
    for (const [code, value] of Object.entries(raw.layout)) {
      if (count >= 256) break;
      if (isCode(code) && code !== '__proto__' && value && typeof value === 'object') {
        memory.layout[code] = value;
        count += 1;
      }
    }
  }
  if (Array.isArray(raw?.guards)) {
    const seen = new Set();
    for (const entry of raw.guards.slice(0, LIMITS.guards)) {
      const guard = guardOf(entry);
      if (guard && !seen.has(guard.code)) {
        seen.add(guard.code);
        memory.guards.push(guard);
      }
    }
  }
  return memory;
}
