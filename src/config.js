// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
//
// Target codes (what the user types and reads in the device names), always
// stored lower case:
//   V4: `r<n>` relay 1-56, `d<n>` digital input 1-56, `fp<n>` pilot-wire zone
//       1-16 (zone z of the X-4FP e: 4 * (e - 1) + z, the `SetFPxx` number),
//       `thl<n>` X-THL 1-4;
//   V5: `r<n>` / `d<n>` the IPX's own relays and inputs 1-8, `x8r<id>-<n>`
//       output n of the X-8R whose IPX id is <id>, `x8d<id>-<n>`,
//       `x24d<id>-<n>`, `x4fp<id>-<z>`, `xthl<id>`.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { API, POLL_INTERVAL, RELAY_KINDS, V4_LIMITS, V5_LIMITS, VERSIONS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  version: 'v5',
  allow_heating_modes: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * The address typed by the user: `{ host, port }`, `{ error: 'path' }` when it
 * holds a path, a query or credentials (a pasted URL, maybe with the key),
 * `{ error: 'https' }`, `{ error: 'invalid' }`, `{}` when empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (/^https:\/\//i.test(text)) {
    return { error: 'https' };
  }
  text = text.replace(/^http:\/\//i, '').replace(/\/$/, '');
  if (/[/?#@\s]/.test(text)) {
    return { error: 'path' };
  }
  let host = text;
  let port;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2];
  } else if (isIP(text) !== 6) {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(text);
    if (withPort) {
      host = withPort[1];
      port = withPort[2];
    } else if (text.includes(':')) {
      return { error: 'invalid' };
    }
  }
  if (isIP(host) === 0 && !HOSTNAME.test(host)) {
    return { error: 'invalid' };
  }
  if (isIP(host) === 4 && /^(0\.|255\.255\.255\.255$|22[4-9]\.|23\d\.)/.test(host)) {
    // Neither "this network", the broadcast nor a multicast group.
    return { error: 'invalid' };
  }
  const portNumber = port === undefined ? API.defaultPort : Number(port);
  if (portNumber < 1 || portNumber > 65535) {
    return { error: 'invalid' };
  }
  return { host: host.toLowerCase(), port: portNumber };
}

/** The key of a controller in /data: a hash of its version, address and port (never the API key). */
export const controllerKey = (version, host, port) =>
  host
    ? createHash('sha256')
        .update(`ipx800:${version}:${host}:${port}`, 'utf8')
        .digest('hex')
        .slice(0, 32)
    : '';

/** An API key: printable ASCII without space, 1 to 128 characters; '' when absent; null when invalid. */
export function parseApiKey(raw) {
  if (raw === undefined || raw === null) {
    return '';
  }
  const text = String(raw).trim();
  if (text === '') {
    return '';
  }
  return /^[\x21-\x7e]{1,128}$/.test(text) ? text : null;
}

// The X-8R id is the `_id` the IPX gives the extension: as large as the layout takes (up to
// 1e9, see src/ipx/model.js), so that every X-8R output published can also be listed.
const RELAY = /^(?:r(\d{1,2})|x8r(\d{1,10})-(\d{1,2}))$/;

/** A relay code of the version, normalized (`r3`, `x8r12-3`); undefined when invalid. */
export function relayCode(text, version) {
  const match = RELAY.exec(String(text).trim().toLowerCase());
  if (!match) {
    return undefined;
  }
  if (match[1] !== undefined) {
    const n = Number(match[1]);
    const max = version === 'v4' ? V4_LIMITS.relays : V5_LIMITS.relays;
    return n >= 1 && n <= max ? `r${n}` : undefined;
  }
  if (version !== 'v5') {
    return undefined;
  }
  const id = Number(match[2]);
  const n = Number(match[3]);
  return id <= V5_LIMITS.maxId && n >= 1 && n <= V5_LIMITS.x8 ? `x8r${id}-${n}` : undefined;
}

/**
 * The relays Gladys may drive: `R1, R3:light, X8R12-2` -> Map(code -> kind).
 * A bare number is a relay of the IPX (`3` = `R3`); no kind = a switch.
 * Every other relay is read only. Wrong entries are reported, not fatal.
 */
export function parseRelays(raw, version) {
  const relays = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^([^:=\s]+)\s*(?:[:=]\s*([a-z]+))?$/i.exec(text);
    const name = match ? (/^\d+$/.test(match[1]) ? `r${match[1]}` : match[1]) : '';
    const code = match ? relayCode(name, version) : undefined;
    const kind = (match?.[2] ?? 'switch').toLowerCase();
    if (!code || !RELAY_KINDS.includes(kind)) {
      errors.push(text.slice(0, 20));
      continue;
    }
    relays.set(code, kind);
  }
  return { relays, errors: errors.slice(0, 10) };
}

const V4_RANGE = {
  r: V4_LIMITS.relays,
  d: V4_LIMITS.inputs,
  fp: V4_LIMITS.zones,
  thl: V4_LIMITS.thl,
};

/**
 * V4 only: what the IPX has beyond its own 8 relays and 8 inputs (the API
 * answers 56 of each, wired or not): `R9-R16, D9-D24, FP1-FP8, THL1`.
 */
export function parseV4Extensions(raw) {
  const codes = new Set();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim().toLowerCase().replace(/\s+/g, '');
    if (text === '') continue;
    const match = /^(r|d|fp|thl)(\d{1,2})(?:-(?:r|d|fp|thl)?(\d{1,2}))?$/.exec(text);
    const prefix = match?.[1];
    const first = Number(match?.[2]);
    const last = match?.[3] === undefined ? first : Number(match[3]);
    const head = match ? /^[a-z]+/.exec(text.split('-')[1] ?? '')?.[0] : undefined;
    if (
      !match ||
      (head !== undefined && head !== prefix) ||
      first < 1 ||
      last < first ||
      last > V4_RANGE[prefix]
    ) {
      errors.push(entry.trim().slice(0, 20));
      continue;
    }
    for (let n = first; n <= last; n += 1) {
      codes.add(`${prefix}${n}`);
    }
  }
  return { codes, errors: errors.slice(0, 10) };
}

const number = (value) =>
  value === undefined || value === null || value === '' ? NaN : Number(value);

const clamp = (value, { min, max }, fallback) =>
  Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;

/** A boolean option: true only when the value is `true` or the text "true". */
const flag = (value, fallback) =>
  value === true || value === 'true'
    ? true
    : value === false || value === 'false'
      ? false
      : fallback;

export function normalizeConfig(raw = {}) {
  const version = String(raw?.version ?? DEFAULTS.version)
    .trim()
    .toLowerCase();
  const v = VERSIONS.includes(version) ? version : DEFAULTS.version;
  const address = parseAddress(raw?.host);
  const typedPort = number(raw?.port);
  const port =
    address.port !== undefined && address.port !== API.defaultPort
      ? address.port
      : clamp(typedPort, { min: 1, max: 65535 }, API.defaultPort);
  const apiKey = parseApiKey(raw?.api_key);
  const relays = parseRelays(raw?.relays, v);
  const extensions =
    v === 'v4' ? parseV4Extensions(raw?.v4_extensions) : { codes: new Set(), errors: [] };
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    version: v,
    host: address.host ?? '',
    port,
    addressError: address.error,
    key: controllerKey(v, address.host, port),
    apiKey: apiKey ?? '',
    apiKeyInvalid: apiKey === null,
    relays: relays.relays,
    relayErrors: relays.errors,
    v4Extensions: extensions.codes,
    extensionErrors: extensions.errors,
    allowHeatingModes: flag(raw?.allow_heating_modes, DEFAULTS.allow_heating_modes),
    pollInterval: clamp(number(raw?.poll_interval), POLL_INTERVAL, DEFAULTS.poll_interval),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** True when the address and the key are there and valid. */
export const isComplete = (config) =>
  config.host !== '' &&
  config.addressError === undefined &&
  config.apiKey !== '' &&
  !config.apiKeyInvalid;

/** What a session depends on: a change starts again (and lifts a refused key). */
export const sessionKey = (config) =>
  JSON.stringify([config.version, config.host, config.port, config.apiKey, config.addressError]);
