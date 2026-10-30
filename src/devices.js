// -----------------------------------------------------------------------------
// The targets of the IPX800 -> Gladys devices and states (pure).
//
// `ext:<selector>:<kind>:<code>`: one Gladys device per relay, digital input,
// pilot-wire zone and X-THL, keyed by the code of the target (`r3`,
// `x8r12-3`, `fp5`, `x4fp7-2`, `xthl9`: see src/config.js). The IPX800 n
// of the configuration (n >= 2) puts `ipx<n>:` before the kind
// (`ext:<selector>:ipx2:relay:r3`); the first one keeps the ids of 0.1.2. The
// kinds, the slot prefix and the feature keys are published forever: never
// rename them. Which IPX800 a slot's devices belong to is kept in /data (the
// owner, see src/app.js), never in the ids.
//
// Relays: read only (`readonly`, a state nobody can drive) unless the user
// declared them in "Relays Gladys may drive", as a switch (`switch`) or a
// light (`light`). A switch or a light obeys every "turn everything off"
// (Google, Alexa, the MCP, the scenes): only the relays the user declares
// get one. The feature key is the kind: declaring a relay adds a feature and
// keeps the old one (and its history). Commands are checked against the
// configuration of now in src/app.js, whatever feature they come from.
//
// Pilot-wire zones: `heater/pilot-wire-mode` (Gladys numbers the modes 0 Off
// to 5 Comfort); the heating modes are refused unless allowed (src/app.js).
//
// A device published again never loses a feature: those of the device
// already created in Gladys are kept as they are.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES as F, KINDS, PILOT, RANGES } from './constants.js';
import { FEATURE_NAMES, slotName, targetName, word } from './i18n.js';

const KIND_LIST = Object.values(KINDS);

const MODELS = {
  x8r: 'X-8R',
  x8d: 'X-8D',
  x24d: 'X-24D',
  x4fp: 'X-4FP',
  xthl: 'X-THL',
  fp: 'X-4FP',
  thl: 'X-THL',
};

/** "IPX800", "IPX800 X-8R"... from the code. */
export const modelOf = (code) => {
  const prefix = /^(x8r|x8d|x24d|x4fp|xthl|fp|thl)\d/.exec(code)?.[1];
  return prefix ? `IPX800 ${MODELS[prefix]}` : 'IPX800';
};

/** The features of a kind (a relay: of its declared kind). */
export function featureKeys(kind, relayKind) {
  switch (kind) {
    case KINDS.RELAY:
      return [relayKind ?? F.READONLY];
    case KINDS.INPUT:
      return [F.STATE];
    case KINDS.PILOT:
      return [F.MODE];
    default:
      return [F.TEMPERATURE, F.HUMIDITY, F.LUMINOSITY];
  }
}

/** The definition of a feature, by key. */
export function definitionOf(key) {
  const binary = { min: 0, max: 1, keep_history: true };
  switch (key) {
    case F.READONLY:
      return {
        category: C.SWITCH,
        type: T.SWITCH.BINARY,
        ...binary,
        read_only: true,
        has_feedback: false,
      };
    case F.SWITCH:
      return {
        category: C.SWITCH,
        type: T.SWITCH.BINARY,
        ...binary,
        read_only: false,
        has_feedback: true,
      };
    case F.LIGHT:
      return {
        category: C.LIGHT,
        type: T.LIGHT.BINARY,
        ...binary,
        read_only: false,
        has_feedback: true,
      };
    case F.STATE:
      return {
        category: C.INPUT,
        type: T.INPUT.BINARY,
        ...binary,
        read_only: true,
        has_feedback: false,
      };
    case F.MODE:
      return {
        category: C.HEATER,
        type: T.HEATER.PILOT_WIRE_MODE,
        min: PILOT.OFF,
        max: PILOT.COMFORT,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    case F.TEMPERATURE:
      return {
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        ...RANGES.temperature,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      };
    case F.HUMIDITY:
      return {
        category: C.HUMIDITY_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.PERCENT,
        ...RANGES.humidity,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      };
    case F.LUMINOSITY:
      return {
        category: C.LIGHT_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.LUX,
        ...RANGES.luminosity,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      };
    default:
      throw new Error(`unknown feature ${key}`);
  }
}

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];

export const idsOf = (gladys, kind, code) => gladys.externalIds(kind, code);

/** What a slot puts before the kind in its ids: '' for the first one, `ipx<n>:` after. */
export const slotPrefix = (slot = 1) => (slot === 1 ? '' : `ipx${slot}:`);

const ID = /:(relay|input|pilot-wire|thl):([a-z0-9-]{2,24})(?::([a-z]{1,20}))?$/;

/** The kind, code and feature key of one of our external ids of `slot`; undefined otherwise. */
export function parseExternalId(externalId, selector, slot = 1) {
  const head = `ext:${selector}:${slotPrefix(slot)}`;
  if (typeof externalId !== 'string' || !externalId.startsWith(head)) {
    return undefined;
  }
  const match = ID.exec(externalId);
  if (!match || !KIND_LIST.includes(match[1])) return undefined;
  if (externalId !== `${head}${match[1]}:${match[2]}${match[3] ? `:${match[3]}` : ''}`) {
    return undefined;
  }
  return { kind: match[1], code: match[2], key: match[3] };
}

/** The slot of one of our external ids (`ext:<selector>:ipx2:...` -> 2); 1 otherwise. */
export function slotOf(externalId, selector) {
  const match = /^ipx([2-9]):/.exec(
    typeof externalId === 'string' && externalId.startsWith(`ext:${selector}:`)
      ? externalId.slice(`ext:${selector}:`.length)
      : '',
  );
  return match ? Number(match[1]) : 1;
}

/**
 * The states of a target read: `[key, state]` pairs, only for the values
 * read (an unknown value publishes nothing, never 0). A relay's state goes
 * to every relay key (`keys`: those of the created device).
 */
export function targetStates(target, keys) {
  const value = target.value;
  if (value === undefined) return [];
  switch (target.kind) {
    case KINDS.RELAY:
      return [F.READONLY, F.SWITCH, F.LIGHT]
        .filter((key) => keys?.has(key))
        .map((key) => [key, { state: value }]);
    case KINDS.INPUT:
      return [[F.STATE, { state: value }]];
    case KINDS.PILOT:
      // A mode out of 0-5 (several modes on) is not one: never published.
      return Number.isInteger(value) && value >= 0 && value <= 5
        ? [[F.MODE, { state: value }]]
        : [];
    default:
      return [
        [F.TEMPERATURE, value.temperature],
        [F.HUMIDITY, value.humidity],
        [F.LUMINOSITY, value.luminosity],
      ]
        .filter(([, v]) => v !== undefined)
        .map(([key, v]) => [key, { state: v }]);
  }
}

/**
 * The Gladys device of a target. `created`: the device already created in
 * Gladys, whose name and features are kept.
 */
export function buildDevice(gladys, target, { language, relayKind, created, slot = 1 }) {
  const ids = idsOf(gladys, target.kind, target.code);
  const built = {
    name: created?.name ?? word(slotName(slot, targetName(target)), language),
    external_id: ids.device,
    model: modelOf(target.code),
    should_poll: false,
    features: featureKeys(target.kind, relayKind).map((key) => ({
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      ...definitionOf(key),
    })),
    params: [{ name: 'code', value: target.code.toUpperCase() }],
  };
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}
