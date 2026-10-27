// -----------------------------------------------------------------------------
// What the answers of the IPX800 mean (pure): the targets the integration
// knows and their values. A target is
//   { code, kind, name?, value, ...ids }
// `value`: 0 / 1 for a relay or an input, a Gladys pilot-wire mode (0-5) for
// a zone, `{ temperature, humidity, luminosity }` for an X-THL; `undefined`
// when the answer does not give it (absent, a text, out of range: never 0).
//
// Every number is checked strictly (a text, '' or null is not 0), every list
// and name is bounded, and nothing the IPX sends becomes an object key
// (Maps only): no prototype pollution.
// -----------------------------------------------------------------------------

import {
  KINDS,
  LIMITS,
  MULTI,
  PILOT,
  RANGES,
  V4_FP_TEXT,
  V4_LIMITS,
  V5_FP_IO,
  V5_LIMITS,
} from '../constants.js';

const own = (object, key) =>
  object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : undefined;

/** 0 or 1 from a number (V4 relays and inputs), undefined otherwise. */
const bit = (value) => (value === 0 || value === 1 ? value : undefined);

/** A finite number within a range, undefined otherwise (never a text). */
const measure = (value, range) =>
  typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max
    ? value
    : undefined;

/** An IPX id: a non-negative integer. */
const isId = (value) => Number.isInteger(value) && value >= 0 && value <= 1e9;

/** A name the IPX gives: printable, bounded; undefined otherwise. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return text === '' ? undefined : text.slice(0, LIMITS.nameLength);
}

/** The THL values of a V4 answer or of the V5 analogs. */
function thlValue(temperature, humidity, luminosity) {
  const value = {
    temperature: measure(temperature, RANGES.temperature),
    humidity: measure(humidity, RANGES.humidity),
    luminosity: measure(luminosity, RANGES.luminosity),
  };
  return value.temperature === undefined &&
    value.humidity === undefined &&
    value.luminosity === undefined
    ? undefined
    : value;
}

// --- V4 ------------------------------------------------------------------------

/** The V4 targets listed: the 8 relays and inputs of the IPX, plus the configured extensions. */
export function v4Codes(extensions, relays) {
  const codes = new Set();
  for (let n = 1; n <= 8; n += 1) {
    codes.add(`r${n}`);
    codes.add(`d${n}`);
  }
  for (const code of extensions ?? []) codes.add(code);
  // A relay declared drivable is listed even without its extension line.
  for (const code of relays?.keys() ?? []) {
    if (/^r\d+$/.test(code)) codes.add(code);
  }
  return codes;
}

/** The kind of a V4 code; undefined when not one. */
export function v4Kind(code) {
  const match = /^(r|d|fp|thl)(\d{1,2})$/.exec(code);
  if (!match) return undefined;
  const n = Number(match[2]);
  const max = { r: V4_LIMITS.relays, d: V4_LIMITS.inputs, fp: V4_LIMITS.zones, thl: V4_LIMITS.thl }[
    match[1]
  ];
  if (n < 1 || n > max) return undefined;
  return { r: KINDS.RELAY, d: KINDS.INPUT, fp: KINDS.PILOT, thl: KINDS.THL }[match[1]];
}

/** `fp5` -> the V4 key `FP2 Zone 1`. */
export const v4ZoneKey = (n) => `FP${Math.floor((n - 1) / 4) + 1} Zone ${((n - 1) % 4) + 1}`;

/**
 * A V4 answer (`Get=all`) -> Map(code -> target) for the codes asked. An
 * answer that is no object, or whose `status` is not "Success", throws.
 */
export function parseV4(json, codes) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { error: 'bad_response' };
  }
  if (own(json, 'status') !== 'Success') {
    return { error: 'not_success' };
  }
  const targets = new Map();
  for (const code of codes) {
    const kind = v4Kind(code);
    const n = Number(/\d+$/.exec(code)?.[0]);
    let value;
    if (kind === KINDS.RELAY) value = bit(own(json, `R${n}`));
    else if (kind === KINDS.INPUT) value = bit(own(json, `D${n}`));
    else if (kind === KINDS.PILOT) {
      const text = own(json, v4ZoneKey(n));
      value = typeof text === 'string' ? V4_FP_TEXT.get(text.trim()) : undefined;
    } else if (kind === KINDS.THL) {
      value = thlValue(
        own(json, `THL${n}-TEMP`),
        own(json, `THL${n}-HUM`),
        own(json, `THL${n}-LUM`),
      );
    } else continue;
    targets.set(code, { code, kind, n, value });
  }
  return { targets };
}

/** The query of a V4 write: `SetR=03`, `ClearR=03`, `SetFP05=3`. */
export function v4WriteQuery(target, value, fpCode) {
  const nn = String(target.n).padStart(2, '0');
  if (target.kind === KINDS.RELAY) {
    return value === 1 ? `SetR=${nn}` : `ClearR=${nn}`;
  }
  if (target.kind === KINDS.PILOT && fpCode !== undefined) {
    return `SetFP${nn}=${fpCode}`;
  }
  return undefined;
}

// --- V5 ------------------------------------------------------------------------

/** A list of `{ _id, ... }` objects (bounded); undefined when not a list. */
function list(json) {
  return Array.isArray(json) ? json.slice(0, LIMITS.items) : undefined;
}

/** An array of `count` ids at `field` of an object; undefined when incomplete. */
function ids(object, field, count) {
  const array = own(object, field);
  if (!Array.isArray(array) || array.length < count) return undefined;
  const out = array.slice(0, count);
  return out.every(isId) ? out : undefined;
}

/** The V5 map of IO and analog values: `{ io: Map(id -> boolean), ana: Map(id -> number) }`. */
export function parseV5Values(ioJson, anaJson) {
  const io = new Map();
  const ana = new Map();
  const ios = list(ioJson);
  if (!ios) return { error: 'bad_response' };
  for (const item of ios) {
    const id = own(item, '_id');
    const on = own(item, 'on');
    if (isId(id) && typeof on === 'boolean') io.set(id, on);
  }
  if (anaJson !== undefined) {
    const anas = list(anaJson);
    if (!anas) return { error: 'bad_response' };
    for (const item of anas) {
      const id = own(item, '_id');
      const value = own(item, 'value');
      if (isId(id) && typeof value === 'number' && Number.isFinite(value)) ana.set(id, value);
    }
  }
  return { io, ana };
}

/**
 * The V5 layout: the IPX's own relays and inputs (`system/ipx`) and the
 * extensions of each type (`ebx/<type>`) -> Map(code -> target without
 * value), with the ids to read and to drive. A type whose list is missing
 * (`undefined`) gives no target (the caller keeps the previous ones).
 */
export function parseV5Layout(ipx, extensions) {
  const targets = new Map();
  const relayState = ids(ipx, 'ioRelayState_id', V5_LIMITS.relays);
  const relayCommand = ids(ipx, 'ioRelays_id', V5_LIMITS.relays);
  if (relayState && relayCommand) {
    for (let n = 1; n <= V5_LIMITS.relays; n += 1) {
      targets.set(`r${n}`, {
        code: `r${n}`,
        kind: KINDS.RELAY,
        n,
        state: relayState[n - 1],
        command: relayCommand[n - 1],
      });
    }
  }
  const inputs = ids(ipx, 'ioDInput_id', V5_LIMITS.inputs);
  if (inputs) {
    for (let n = 1; n <= V5_LIMITS.inputs; n += 1) {
      targets.set(`d${n}`, { code: `d${n}`, kind: KINDS.INPUT, n, state: inputs[n - 1] });
    }
  }
  const types = new Set();
  for (const [type, raw] of extensions) {
    const entries = list(raw);
    if (!entries) continue;
    types.add(type);
    for (const ext of entries.slice(0, V5_LIMITS.extensions)) {
      const id = own(ext, '_id');
      if (!isId(id)) continue;
      const name = cleanName(own(ext, 'name'));
      if (type === 'x8r') {
        const state = ids(ext, 'ioOutputState_id', V5_LIMITS.x8);
        const command = ids(ext, 'ioOutput_id', V5_LIMITS.x8);
        if (!state || !command) continue;
        for (let k = 1; k <= V5_LIMITS.x8; k += 1) {
          const code = `x8r${id}-${k}`;
          targets.set(code, {
            code,
            kind: KINDS.RELAY,
            ext: id,
            extName: name,
            n: k,
            state: state[k - 1],
            command: command[k - 1],
          });
        }
      } else if (type === 'x8d' || type === 'x24d') {
        const count = type === 'x8d' ? V5_LIMITS.x8 : V5_LIMITS.x24;
        const state = ids(ext, 'ioInput_id', count);
        if (!state) continue;
        for (let k = 1; k <= count; k += 1) {
          const code = `${type}${id}-${k}`;
          targets.set(code, {
            code,
            kind: KINDS.INPUT,
            ext: id,
            extName: name,
            n: k,
            state: state[k - 1],
          });
        }
      } else if (type === 'x4fp') {
        const modes = new Map();
        for (const [mode, field] of V5_FP_IO) {
          const array = ids(ext, field, V5_LIMITS.zones);
          if (array) modes.set(mode, array);
        }
        if (modes.size !== V5_FP_IO.size) continue;
        for (let z = 1; z <= V5_LIMITS.zones; z += 1) {
          const code = `x4fp${id}-${z}`;
          const io = {};
          for (const [mode, array] of modes) io[mode] = array[z - 1];
          targets.set(code, { code, kind: KINDS.PILOT, ext: id, extName: name, n: z, io });
        }
      } else if (type === 'xthl') {
        const temperature = own(ext, 'anaTemp_id');
        const humidity = own(ext, 'anaHum_id');
        const luminosity = own(ext, 'anaLum_id');
        if (![temperature, humidity, luminosity].every(isId)) continue;
        const code = `xthl${id}`;
        targets.set(code, {
          code,
          kind: KINDS.THL,
          ext: id,
          extName: name,
          ana: { temperature, humidity, luminosity },
        });
      }
    }
  }
  return { targets, types };
}

/** The value of a V5 target from the IO and analog maps; undefined when not readable. */
export function v5Value(target, values) {
  if (target.kind === KINDS.RELAY || target.kind === KINDS.INPUT) {
    const on = values.io.get(target.state);
    return on === undefined ? undefined : on ? 1 : 0;
  }
  if (target.kind === KINDS.PILOT) {
    // Exactly one mode on: that mode; none: unknown; several: MULTI (unreadable, never published).
    let found;
    for (const [mode, id] of Object.entries(target.io)) {
      const on = values.io.get(id);
      if (on === undefined) return undefined;
      if (on) {
        if (found !== undefined) return MULTI;
        found = Number(mode);
      }
    }
    return found;
  }
  if (target.kind === KINDS.THL) {
    return thlValue(
      values.ana.get(target.ana.temperature),
      values.ana.get(target.ana.humidity),
      values.ana.get(target.ana.luminosity),
    );
  }
  return undefined;
}

/** The V5 IO a command drives and the value it puts there; undefined when none. */
export function v5Write(target, value) {
  if (target.kind === KINDS.RELAY) {
    return { id: target.command, on: value === 1 };
  }
  if (target.kind === KINDS.PILOT) {
    const id = target.io?.[value];
    return isId(id) ? { id, on: true } : undefined;
  }
  return undefined;
}

/** The parts of a V5 target kept in /data (no value): what a protective command needs after a restart. */
export function v5Kept(target) {
  if (target.kind === KINDS.RELAY) {
    return { kind: target.kind, state: target.state, command: target.command };
  }
  if (target.kind === KINDS.PILOT) {
    return { kind: target.kind, io: { ...target.io } };
  }
  return undefined;
}

/** A V5 target read back from /data, checked; undefined when not valid. */
export function v5FromKept(code, kept) {
  if (kept?.kind === KINDS.RELAY && /^(r\d|x8r\d+-\d)$/.test(code)) {
    return isId(kept.state) && isId(kept.command)
      ? { code, kind: KINDS.RELAY, state: kept.state, command: kept.command }
      : undefined;
  }
  if (kept?.kind === KINDS.PILOT && /^x4fp\d+-[1-4]$/.test(code)) {
    const io = {};
    for (const mode of V5_FP_IO.keys()) {
      const id = own(kept.io, String(mode));
      if (!isId(id)) return undefined;
      io[mode] = id;
    }
    return { code, kind: KINDS.PILOT, io };
  }
  return undefined;
}

export { PILOT };
