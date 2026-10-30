// -----------------------------------------------------------------------------
// Constants: the two local APIs of the GCE IPX800 (V4 and V5), the targets the
// integration knows, the manifest keys, the limits and the timings.
//
// IPX800 V4 (GCE wiki "API V4"): GET /api/xdevices.json?key=<API key>&...
//   - `Get=all` reads every element (relays `R1`..`R56`, digital inputs
//     `D1`..`D56`, the pilot-wire zones `FP<ext> Zone <z>` as a text, the
//     X-THL `THL<n>-TEMP|HUM|LUM`), answered with `"status": "Success"`;
//   - `SetR=01` / `ClearR=01` switch a relay on / off (01 to 56);
//   - `SetFPxx=y` sets the pilot-wire zone xx (01 to 16): 0 Comfort, 1 Eco,
//     2 Frost protection, 3 Off, 4 Comfort -1, 5 Comfort -2.
// IPX800 V5 (no public reference: as pypx800v5 1.5.0 uses it, MIT):
//   GET|PUT /api/<path>?ApiKey=<API key>
//   - `system/ipx?option=filter_id`: the ids of the IPX's own relays and inputs;
//   - `ebx/<type>?option=filter_id`: the extensions of a type, each with its
//     `_id`, `name` and the ids of its IOs / analog values;
//   - `core/io` / `core/ana`: every IO (`{ _id, on }`) / analog (`{ _id, value }`);
//   - `PUT core/io/<id>` with `{ "on": true|false }` drives an IO.
// The API key travels in the query string of both versions: a URL is never
// logged, nor put in an error, a status or /data.
// -----------------------------------------------------------------------------

export const VERSIONS = ['v5', 'v4'];

export const API = {
  defaultPort: 80,
  v4: { path: '/api/xdevices.json', keyParam: 'key' },
  v5: { base: '/api/', keyParam: 'ApiKey' },
};

/** The pilot-wire modes as Gladys numbers them (PILOT_WIRE_MODE of the core). */
export const PILOT = {
  OFF: 0,
  FROST_PROTECTION: 1,
  ECO: 2,
  COMFORT_1: 3,
  COMFORT_2: 4,
  COMFORT: 5,
};

/** Protective modes: never refused by an option, a pause, a queue or a read in progress. */
export const PROTECTIVE_MODES = [PILOT.OFF, PILOT.FROST_PROTECTION];

/** A V5 zone with several mode IOs on: its mode cannot be read (never published). */
export const MULTI = -1;

/** V4: the text a zone reads -> the Gladys mode; the Gladys mode -> the `SetFPxx` code. */
export const V4_FP_TEXT = new Map([
  ['Confort', PILOT.COMFORT],
  ['Eco', PILOT.ECO],
  ['Hors Gel', PILOT.FROST_PROTECTION],
  ['Arret', PILOT.OFF],
  ['Arrêt', PILOT.OFF],
  ['Confort -1', PILOT.COMFORT_1],
  ['Confort -2', PILOT.COMFORT_2],
]);
export const V4_FP_CODE = new Map([
  [PILOT.COMFORT, 0],
  [PILOT.ECO, 1],
  [PILOT.FROST_PROTECTION, 2],
  [PILOT.OFF, 3],
  [PILOT.COMFORT_1, 4],
  [PILOT.COMFORT_2, 5],
]);

/** V5: the X-4FP IO of each mode (`io<Name>_id`, one per zone), by Gladys mode. */
export const V5_FP_IO = new Map([
  [PILOT.COMFORT, 'ioComfort_id'],
  [PILOT.ECO, 'ioEco_id'],
  [PILOT.FROST_PROTECTION, 'ioAntiFreeze_id'],
  [PILOT.OFF, 'ioStop_id'],
  [PILOT.COMFORT_1, 'ioComfort_1_id'],
  [PILOT.COMFORT_2, 'ioComfort_2_id'],
]);

/** The V5 extensions read (their `ebx/<type>` list). */
export const V5_EXTENSIONS = ['x8r', 'x8d', 'x24d', 'x4fp', 'xthl'];

/** Kinds of targets (the type part of the external ids): frozen. */
export const KINDS = {
  RELAY: 'relay',
  INPUT: 'input',
  PILOT: 'pilot-wire',
  THL: 'thl',
};

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  /** Relays: the key is the kind the user gave it (a new kind adds a feature). */
  READONLY: 'readonly',
  SWITCH: 'switch',
  LIGHT: 'light',
  STATE: 'state',
  MODE: 'mode',
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  LUMINOSITY: 'luminosity',
};

/** What a relay declared in the configuration becomes. */
export const RELAY_KINDS = [FEATURES.SWITCH, FEATURES.LIGHT];

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ATTACH: 'attach_devices',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = { min: 5, max: 300, default: 10 };

/** Sizes of the V4 controller (the API answers them all, wired or not). */
/** X-THL: the GCE wiki numbers their measurements up to 42 (3 each): 14 sensors (to check). */
export const V4_LIMITS = { relays: 56, inputs: 56, zones: 16, thl: 14 };
/** V5: the IPX's own relays and inputs; outputs per extension. */
export const V5_LIMITS = {
  relays: 8,
  inputs: 8,
  extensions: 16,
  zones: 4,
  x8: 8,
  x24: 24,
  /** The largest IPX id taken (IOs, analogs, extensions). */
  maxId: 1e9,
};

/** A measurement out of these ranges is not one (never published). */
export const RANGES = {
  temperature: { min: -40, max: 85 },
  humidity: { min: 0, max: 100 },
  luminosity: { min: 0, max: 200_000 },
};

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** An answer is read up to this size, then dropped (V4 `Get=all`: ~6 KB; V5 `core/io`: tens of KB). */
  responseBytes: { v4: 64 * 1024, v5: 1024 * 1024 },
  /** Items of a V5 list kept (IOs, analogs, extensions): more is not an IPX800. */
  items: 4096,
  /** Names are cut to this length. */
  nameLength: 60,
  /** Non-protective commands waiting (a scene); protective ones are never refused for room. */
  commandQueue: 16,
  /** Protective commands kept in /data to send again. */
  guards: 128,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling. */
  requestTimeout: 5 * SECOND,
  /** A round (V5: the lists, then the values) takes no longer than this. */
  roundBudget: 20 * SECOND,
  /** Failed rounds: 10 s, 30 s, 1, 2 then 5 min, never shorter than the interval. */
  backoff: [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The controller asks to wait (429, 503): at least a minute. */
  busyPause: MINUTE,
  /** A pause is never longer than this, whatever /data holds. */
  pauseMax: HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** "Test the connection" reads at most this often; it answers within 25 s (Gladys waits 30 s). */
  testCooldown: 10 * SECOND,
  testBudget: 25 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): written by 3.5 s after the
   * click or refused unsent; the read back awaited until 4.3 s, after which
   * the command is "sent, without confirmation" and read again later.
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** A protective command not sent at once is tried again during this budget. */
  protectiveRetry: 250,
  protectiveRetryGap: 50,
  /** A protective write without answer for this long is cut when another one waits. */
  stuckProtective: SECOND,
  /** Between two requests to the IPX (after the previous connection is closed). */
  laneGap: 10,
  /** A request cut by a protective command is closed within this (socket destroyed). */
  cutWait: 500,
  /** Reads after a command: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A protective command contradicted by the reads is sent again this many times at most. */
  resendMax: 3,
  /** The configuration of Gladys not read: new tries 5 s, 15 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE],
  /** A click while the configuration is unread asks for it at once (2 s apart at most) and waits this long. */
  configAskGap: 2 * SECOND,
  configWait: 3 * SECOND,
  /** At start, an Off waits this long at most for the MAC of a V5 to be read. */
  identityWait: 1_500,
  /** "Attach the devices": the second click within this. */
  attachConfirm: MINUTE,
  /**
   * A read or a save of /data is waited for this long at most: a frozen disk never holds a
   * read of the IPX800, a start, the test button nor an Off (unreadable, or not written).
   */
  storeWait: 1_500,
};
