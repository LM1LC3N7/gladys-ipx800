// -----------------------------------------------------------------------------
// The integration: the IPX800 (V4 or V5) typed in the configuration, read
// every poll interval through its local HTTP API; one Gladys device per
// relay, digital input, pilot-wire zone and X-THL; the commands; the "Test
// the connection" button. index.js only wires the SDK handlers.
//
// One round: V4 `Get=all` (one request); V5 the layout (`system/ipx`, then
// `ebx/<type>` of each extension type) and the values (`core/io`,
// `core/ana`). A V5 extension list that fails keeps the targets of that
// type read before (a secondary list never stops the round); `core/ana`
// failing only leaves the X-THL unread. The values of a round go to the
// targets of the ids read in that round.
//
// The pace is kept across restarts: never two rounds less than an interval
// apart, whatever asks (a reconnection, a save of the form, the test button,
// the Discover tab, a restart: the time of the last attempt is kept in /data
// before the read). A failed round pauses 10 s, 30 s, 1, 2 then 5 min (a
// minute at least when the IPX asks to wait), the pause kept in /data. A
// refused API key stops the reads until the key changes or the test button
// succeeds. A configuration of Gladys that cannot be read is read again (5 s,
// 15 s, 1 min, then every 5 min), at every connection to Gladys.
//
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces
// the reads, the pauses, the deadlines and the publication budget. The clock
// is read once per decision (`dueAt(mono)` computes on the caller's instant).
//
// Commands (one lane of requests to the IPX, see src/ipx/client.js):
//   - protective: pilot wire Off and Frost protection, a relay switched off.
//     Never refused by the heating option, a pause, a refused key, the
//     queue, a read or a command in progress, nor before the first read
//     (the V5 ids are kept in /data). They cut the request in flight, cancel
//     the commands of the same target still waiting, are tried again for
//     250 ms, then kept in /data (a guard) and sent again by the reads that
//     contradict them (3 times at most). A guard is lifted by a later
//     command on the target that left (a click), by another protective
//     command, or once confirmed, by another value read twice in a row
//     (changed on the IPX itself); never by the time.
//   - the others (a declared relay switched on, the heating modes Eco and
//     Comfort behind `allow_heating_modes`): a bounded queue served one at a
//     time; the option, the declaration and the deadline checked on arrival
//     and again right before the request leaves; a heating mode needs /data
//     written first.
//   - written within 3.5 s of the click or refused "nothing was sent";
//     confirmed by a read back of the IPX that left after the write (shared
//     by the commands of a scene); a read back equal to the state before is
//     "not applied yet"; a write that may have left is never "not sent".
//     The ack never waits for a publication to Gladys.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { isComplete, normalizeConfig, sessionKey } from './config.js';
import {
  FEATURES as F,
  KINDS,
  LIMITS,
  PROTECTIVE_MODES,
  TIMINGS,
  V4_FP_CODE,
  V5_EXTENSIONS,
} from './constants.js';
import { buildDevice, idsOf, parseExternalId, targetStates } from './devices.js';
import { ERRORS, T, age, both, describe, join, listOf, reasonOf, shownCode, word } from './i18n.js';
import { IpxClient, PRIORITY } from './ipx/client.js';
import { IpxError, errorReason } from './ipx/http.js';
import {
  parseV4,
  parseV5Layout,
  parseV5Values,
  v4Codes,
  v4Kind,
  v4WriteQuery,
  v5FromKept,
  v5Kept,
  v5Value,
  v5Write,
} from './ipx/model.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, normalizeMemory } from './store.js';

/**
 * The tag of a refused API key: 8 bits of a salted hash, never more (the key
 * must not be found back from /data). Two keys share it once in 256: the
 * test button then tries anyway.
 */
export const tagOf = (salt, key) =>
  createHash('sha256').update(`${salt}\u0000${key}`, 'utf8').digest()[0];

/** A command value from Gladys: an integer (or its plain text); undefined otherwise. */
function integerOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,2}$/.test(value)) return Number(value);
  return undefined;
}

/** Is this command protective (never refused, sent first)? */
export const isProtective = (kind, value) =>
  (kind === KINDS.PILOT && PROTECTIVE_MODES.includes(value)) ||
  (kind === KINDS.RELAY && value === 0);

export class IpxApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'ipx800' }),
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    random = () => randomBytes(16).toString('hex'),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.random = random;
    // The budget of 300 states a minute counts on the monotonic clock.
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.configLoaded = false;
    this.configTries = 0;
    this.configTimer = undefined;
    this.configGeneration = 0;
    this.memory = emptyMemory();
    this.storeUnreadable = false;
    this.saveFailed = false;
    this.client = undefined;
    this.generation = 0;
    this.started = false;
    /** code -> target (with `value` and `at`, the monotonic time its read left). */
    this.model = new Map();
    this.round = undefined;
    this.lastReadAt = undefined;
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastReason = undefined;
    /** code -> guard of a protective command: { code, kind, value, resends, confirmed, other, seq, sentAt, inFlight }. */
    this.guards = new Map();
    this.seq = 0;
    /** code -> { en, fr }: a command the read back contradicts, until a read shows it. */
    this.warnings = new Map();
    /** code -> { expected, before, at }: a command not yet seen in a read. */
    this.pendingWrites = new Map();
    this.commands = [];
    this.serving = undefined;
    this.readBackJob = undefined;
    this.timer = undefined;
    this.followUps = new Set();
    this.running = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.lastTestAt = -Infinity;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Connected to Gladys (each time): the configuration is read (`load`, the
   * SDK's getConfig), and read again on failure (5 s, 15 s, 1 min, then
   * every 5 min) with a status saying so.
   */
  async onConnected(load) {
    this.configLoader = load;
    this.configTries = 0;
    this.clearConfigTimer();
    await this.loadConfig();
  }

  async loadConfig() {
    const generation = ++this.configGeneration;
    let raw;
    try {
      raw = await this.configLoader();
    } catch (err) {
      if (generation !== this.configGeneration) {
        return;
      }
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger.warn(
        `ipx800: configuration not read (${err?.name ?? 'Error'}); new try in ${Math.round(wait / 1000)} s`,
      );
      await this.setStatus(false, T.configNotRead(age(wait)));
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.loadConfig().catch(() => {});
      }, wait);
      return;
    }
    if (generation !== this.configGeneration) {
      return;
    }
    this.configTries = 0;
    await this.connected(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /**
   * The configuration of Gladys read. The first time, start; after a
   * reconnection (Gladys restarted), apply it and resend what Gladys keeps in
   * memory only (the status, the Discovery list); the values follow at the
   * next read, never the old ones.
   */
  async connected(raw = {}) {
    if (!this.started || !this.configLoaded) {
      this.configLoaded = true;
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.gladys.forgetPublishedStates?.();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
  }

  async start(raw = {}) {
    try {
      await this.startNow(raw);
    } catch (err) {
      // Never left without a timer, whatever failed.
      this.logger.error(`ipx800: start failed (${err?.name ?? 'Error'})`);
      this.failures += 1;
      this.setPause(this.monotonic(), TIMINGS.backoff[0], 'failed');
      this.schedule();
    }
  }

  async startNow(raw = {}) {
    this.stop();
    await this.running?.catch(() => {});
    this.config = normalizeConfig(raw);
    this.configLoaded = true;
    this.reset();
    const now = this.now();
    const mono = this.monotonic();
    let loaded = null;
    this.storeUnreadable = false;
    try {
      loaded = await this.store.load();
    } catch (err) {
      // Not the same as empty: nothing is written over it until it reads again.
      this.storeUnreadable = true;
      this.logger.warn(`ipx800: /data unreadable (${err?.code ?? 'error'})`);
    }
    this.adoptMemory(normalizeMemory(loaded, now), now, mono);
    this.publisher.start();
    const missing = this.configMessage();
    if (missing) {
      await this.setStatus(false, missing);
      return;
    }
    this.client = new IpxClient({
      version: this.config.version,
      host: this.config.host,
      port: this.config.port,
      apiKey: this.config.apiKey,
      transport: this.transport,
      monotonic: this.monotonic,
    });
    await this.saveMemory();
    if (this.refusedApplies()) {
      await this.setStatus(false, T.refused);
    } else {
      await this.setStatus(false, this.pause ? this.pauseMessage(mono) : T.connecting);
    }
    await this.publishDevices();
    // The protective commands kept in /data and not seen applied leave now,
    // before the first read (after a restart or a new configuration).
    for (const guard of this.guards.values()) {
      if (!guard.confirmed && guard.resends < TIMINGS.resendMax) {
        this.resendGuard(guard);
      }
    }
    this.schedule();
    // The first round now when it is due; not awaited (a slow IPX never holds the start).
    this.tick();
  }

  /** What /data holds, for this controller only. */
  adoptMemory(saved, now, mono) {
    if (saved.lastAttemptAt !== null) {
      // Whatever the controller: never two reads within an interval.
      this.lastReadAt = mono - (now - saved.lastAttemptAt);
    }
    if (saved.key !== this.config.key) {
      // Another controller: its pause, refusal, layout and guards are not this one's.
      saved.key = this.config.key;
      saved.pause = null;
      saved.refused = null;
      saved.layout = {};
      saved.guards = [];
    }
    this.memory = saved;
    if (saved.pause && saved.pause.until > now) {
      this.pause = {
        due: mono + (saved.pause.until - now),
        failures: saved.pause.failures,
        code: saved.pause.code,
      };
      this.failures = saved.pause.failures;
    }
    if (this.config.version === 'v4') {
      // V4: the targets come from the configuration; a command can leave before the first read.
      for (const code of v4Codes(this.config.v4Extensions, this.config.relays)) {
        const kind = v4Kind(code);
        if (kind) {
          const n = Number(/\d+$/.exec(code)[0]);
          this.model.set(code, { code, kind, n, value: undefined, at: undefined });
        }
      }
    } else {
      for (const [code, kept] of Object.entries(saved.layout)) {
        const target = v5FromKept(code, kept);
        if (target)
          this.model.set(code, { ...target, value: undefined, at: undefined, kept: true });
      }
    }
    for (const g of saved.guards) {
      this.guards.set(g.code, { ...g, seq: 0, sentAt: -Infinity, inFlight: false });
    }
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const timer of this.followUps) {
      this.timers.clearTimeout(timer);
    }
    this.followUps.clear();
    this.publisher.stop();
    for (const job of this.commands.splice(0)) {
      job.reject(
        this.refusal(ERRORS.notSent(both('integration restarting', 'intégration en redémarrage'))),
      );
    }
    this.client?.close();
    this.client = undefined;
  }

  /** The container stops: every timer, /data written. */
  async shutdown() {
    this.configGeneration += 1;
    this.clearConfigTimer();
    this.stop();
    await this.saveMemory();
  }

  clearTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  reset() {
    this.model.clear();
    this.round = undefined;
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastReason = undefined;
    this.guards.clear();
    this.warnings.clear();
    this.pendingWrites.clear();
    this.published = undefined;
    this.lastStatus = undefined;
  }

  configMessage() {
    if (this.config.addressError === 'path') return T.addressPath;
    if (this.config.addressError === 'https') return T.addressHttps;
    if (this.config.addressError === 'invalid') return T.addressInvalid;
    if (this.config.apiKeyInvalid) return T.apiKeyInvalid;
    return isComplete(this.config) ? undefined : T.noConfig;
  }

  /** A new controller or key: start again; the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    this.clearConfigTimer();
    if (!this.started || !this.configLoaded || sessionKey(next) !== sessionKey(previous)) {
      this.started = true;
      this.configLoaded = true;
      return this.start(raw);
    }
    this.config = next;
    if (next.allowHeatingModes !== previous.allowHeatingModes) {
      this.logger.info(`ipx800: heating modes ${next.allowHeatingModes ? 'allowed' : 'off'}`);
    }
    if (next.pollInterval !== previous.pollInterval) {
      this.schedule();
    }
    this.published = undefined;
    await this.publishDevices();
    if (this.round && !this.offline && !this.refusedApplies()) {
      await this.setStatus(true, this.statusMessage());
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  // --- /data -------------------------------------------------------------------

  /** The guards, the layout and the pause into the memory written to /data. */
  syncMemory(mono = this.monotonic()) {
    const now = this.now();
    this.memory.key = this.config.key;
    this.memory.pause = this.pause
      ? {
          until: now + Math.max(0, this.pause.due - mono),
          failures: this.failures,
          code: this.pause.code,
        }
      : null;
    this.memory.guards = [...this.guards.values()].slice(0, LIMITS.guards).map((g) => ({
      code: g.code,
      kind: g.kind,
      value: g.value,
      resends: g.resends,
      confirmed: g.confirmed,
      ...(g.other !== undefined ? { other: g.other } : {}),
    }));
    if (this.config.version === 'v5') {
      const layout = {};
      for (const [code, target] of this.model) {
        const kept = v5Kept(target);
        if (kept) layout[code] = kept;
      }
      this.memory.layout = layout;
    }
  }

  /** true when /data was written. A failure is logged once until a save succeeds again. */
  async saveMemory() {
    if (this.storeUnreadable) {
      // Read again first: what it holds is never overwritten unseen.
      try {
        const loaded = normalizeMemory(await this.store.load(), this.now());
        this.storeUnreadable = false;
        if (loaded.key === this.config.key) {
          for (const g of loaded.guards) {
            if (!this.guards.has(g.code)) {
              this.guards.set(g.code, { ...g, seq: 0, sentAt: -Infinity, inFlight: false });
            }
          }
          this.memory.refused ??= loaded.refused;
        }
      } catch {
        return false;
      }
    }
    this.syncMemory();
    try {
      await this.store.save(this.memory);
      if (this.saveFailed) {
        this.saveFailed = false;
        this.logger.info('ipx800: /data written again');
      }
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.saveFailed = true;
        this.logger.warn(`ipx800: saving the state to /data failed (${err?.code ?? 'error'})`);
      }
      return false;
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Pace --------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  /** The rest of the pause (ms), capped at every use; 0 when none. */
  pauseLeft(mono) {
    if (!this.pause) return 0;
    return Math.min(Math.max(0, this.pause.due - mono), TIMINGS.pauseMax);
  }

  /** The monotonic time from which the next round may start, from the caller's instant `mono`. */
  dueAt(mono) {
    const due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval;
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  setPause(mono, wait, code) {
    this.pause = { due: mono + Math.min(wait, TIMINGS.pauseMax), failures: this.failures, code };
  }

  pauseMessage(mono) {
    const reason =
      this.lastReason ?? both('earlier reads failed', 'les lectures précédentes ont échoué');
    return T.unreachable(reason, age(this.pauseLeft(mono)));
  }

  /** Whether the API key the IPX refused is the one configured now. */
  refusedApplies() {
    const r = this.memory.refused;
    return Boolean(r && r.tag === tagOf(r.salt, this.config.apiKey));
  }

  /** One timer: the next round when it is due; none while the key is refused. */
  schedule() {
    this.clearTimer();
    if (!this.client || this.refusedApplies()) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      return generation === this.generation ? this.tick() : undefined;
    }, wait);
  }

  /** One round at a time: a tick during a round joins it. */
  tick({ evenRefused = false } = {}) {
    if (!this.running) {
      const generation = this.generation;
      this.running = this.read({ evenRefused })
        .catch((err) => this.recover(err, generation))
        .finally(() => {
          this.running = undefined;
        });
    }
    return this.running;
  }

  /** An internal error (a bug, never an answer of the IPX): a pause, and the next round scheduled. */
  async recover(err, generation) {
    this.logger.error(`ipx800: unexpected error (${err?.name ?? 'Error'}: ${err?.message ?? err})`);
    if (generation !== this.generation) return;
    this.failures += 1;
    this.setPause(this.monotonic(), Math.max(this.interval, TIMINGS.backoff[0]), 'failed');
    this.schedule();
  }

  async read({ evenRefused }) {
    const generation = this.generation;
    const client = this.client;
    if (!client || (!evenRefused && this.refusedApplies())) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) {
      this.schedule();
      return;
    }
    const gone = () => generation !== this.generation;
    this.lastReadAt = mono;
    // Kept BEFORE the read: a restart during it never reads again sooner.
    this.memory.lastAttemptAt = this.now();
    await this.saveMemory();
    if (gone()) return;
    let result;
    try {
      result = await this.readRound(client, mono);
    } catch (err) {
      if (gone()) return;
      if (err instanceof IpxError && err.code === 'cut') {
        // Cut by a protective command: not a failure; the next round at its time.
        this.schedule();
        return;
      }
      await this.failed(err, mono);
      this.schedule();
      return;
    }
    if (gone()) return;
    await this.succeeded(result);
    if (!gone()) this.schedule();
  }

  /** One round: `{ targets: Map, at, unreadTypes }`. Throws an IpxError for the whole round. */
  async readRound(client, started) {
    const budget = started + TIMINGS.roundBudget;
    const hooks = (stamp) => ({
      deadline: Math.min(this.monotonic() + TIMINGS.requestTimeout, budget),
      onSent: stamp,
    });
    if (this.config.version === 'v4') {
      let at;
      const json = await client.v4ReadAll(
        PRIORITY.READ,
        hooks(() => (at = this.monotonic())),
      );
      const parsed = parseV4(json, v4Codes(this.config.v4Extensions, this.config.relays));
      if (parsed.error) throw new IpxError(parsed.error, 'not an IPX800 V4 answer', { sent: true });
      return { targets: parsed.targets, at, unreadTypes: [] };
    }
    const ipx = await client.v5Ipx(PRIORITY.READ, hooks());
    const extensions = new Map();
    const unreadTypes = [];
    for (const type of V5_EXTENSIONS) {
      try {
        extensions.set(type, await client.v5Extensions(type, PRIORITY.READ, hooks()));
      } catch (err) {
        if (!(err instanceof IpxError) || ['cut', 'busy'].includes(err.code)) throw err;
        // A secondary list failing never stops the round: the targets read before are kept.
        unreadTypes.push(type);
      }
    }
    const layout = parseV5Layout(ipx, extensions);
    let at;
    const io = await client.v5Io(
      PRIORITY.READ,
      hooks(() => (at = this.monotonic())),
    );
    let ana;
    try {
      ana = await client.v5Ana(PRIORITY.READ, hooks());
    } catch (err) {
      if (!(err instanceof IpxError) || ['cut', 'busy'].includes(err.code)) throw err;
      ana = [];
      unreadTypes.push('ana');
    }
    const values = parseV5Values(io, ana);
    if (values.error) throw new IpxError(values.error, 'not an IPX800 V5 answer', { sent: true });
    const targets = new Map();
    for (const [code, target] of layout.targets) {
      targets.set(code, { ...target, value: v5Value(target, values) });
    }
    // The types not read this time: the targets read before, still known, not fresh.
    for (const [code, target] of this.model) {
      const type = /^(x8r|x8d|x24d|x4fp|xthl)\d/.exec(code)?.[1];
      if (!targets.has(code) && type && !layout.types.has(type)) {
        // Its ids were not checked in this round: no value from them.
        targets.set(code, { ...target, value: undefined });
      }
    }
    return { targets, at, unreadTypes };
  }

  async succeeded({ targets, at, unreadTypes }) {
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastReason = undefined;
    if (this.memory.refused) {
      this.memory.refused = null;
      this.logger.info('ipx800: the IPX accepts the API key again');
    }
    this.model = new Map();
    for (const [code, target] of targets) {
      this.model.set(code, { ...target, at });
    }
    this.round = { unreadTypes };
    this.applyRead(at);
    await this.saveMemory();
    await this.setStatus(true, this.statusMessage());
    await this.publishDevices();
    await this.flush();
  }

  /** The round failed: a pause; a refused key stops the reads. */
  async failed(err, mono) {
    if (err instanceof IpxError && err.code === 'refused') {
      const salt = this.random();
      this.memory.refused = { salt, tag: tagOf(salt, this.config.apiKey) };
      this.offline = true;
      this.lastReason = reasonOf(err);
      this.logger.warn('ipx800: the IPX refused the API key; no read until it changes');
      await this.saveMemory();
      await this.setStatus(false, T.refused);
      return;
    }
    const busy = err instanceof IpxError && err.code === 'busy';
    const wait = Math.max(
      this.interval,
      busy ? TIMINGS.busyPause : 0,
      TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
    );
    this.failures += 1;
    this.setPause(mono, wait, busy ? 'busy' : 'failed');
    this.offline = true;
    this.lastReason = reasonOf(err);
    this.logger.warn(`ipx800: ${errorReason(err)}; next try in ${Math.round(wait / 1000)} s`);
    await this.saveMemory();
    await this.setStatus(false, T.unreachable(this.lastReason, age(wait)));
  }

  /** The counts and the warnings of the last round. */
  statusMessage() {
    const counts = { relays: 0, inputs: 0, zones: 0, thl: 0 };
    for (const target of this.model.values()) {
      if (target.kind === KINDS.RELAY) counts.relays += 1;
      else if (target.kind === KINDS.INPUT) counts.inputs += 1;
      else if (target.kind === KINDS.PILOT) counts.zones += 1;
      else counts.thl += 1;
    }
    const parts = [T.connected(this.config.version, counts)];
    if (this.config.relayErrors.length > 0) {
      parts.push(T.relayErrors(listOf(this.config.relayErrors)));
    }
    if (this.config.extensionErrors.length > 0) {
      parts.push(T.extensionErrors(listOf(this.config.extensionErrors)));
    }
    const missing = [...this.config.relays.keys()].filter((code) => !this.model.has(code));
    if (missing.length > 0) {
      parts.push(T.relaysMissing(listOf(missing.map(shownCode))));
    }
    if (this.round?.unreadTypes.length > 0) {
      parts.push(T.typesUnread(listOf(this.round.unreadTypes.map((t) => t.toUpperCase()))));
    }
    const pending = [...this.guards.values()].filter((g) => !g.confirmed);
    const failing = pending
      .filter((g) => g.resends >= TIMINGS.resendMax)
      .map((g) => shownCode(g.code));
    const resent = pending
      .filter((g) => g.resends < TIMINGS.resendMax)
      .map((g) => shownCode(g.code));
    if (resent.length > 0) parts.push(T.guardsPending(listOf(resent)));
    if (failing.length > 0) parts.push(T.guardsFailed(listOf(failing)));
    if (this.warnings.size > 0) {
      parts.push(T.notApplied(listOf([...this.warnings.keys()].map(shownCode))));
    }
    if (this.saveFailed || this.storeUnreadable) parts.push(T.storeProblem);
    return join(...parts);
  }

  async refreshStatus() {
    if (this.round && !this.offline && !this.refusedApplies()) {
      await this.setStatus(true, this.statusMessage());
    }
    await this.flush();
  }

  // --- What a read changes -----------------------------------------------------------

  /**
   * After a read that left at `at` (a round or a read back): the states, the
   * commands checked against it, the guards checked against it (only reads
   * that left after the guard's last send count).
   */
  applyRead(at, { resend = true } = {}) {
    const created = this.createdFeatures();
    for (const target of this.model.values()) {
      if (target.at !== at) continue;
      this.queueStates(target, created);
      const pending = this.pendingWrites.get(target.code);
      if (pending && at > pending.at && target.value !== undefined) {
        if (target.value === pending.expected) {
          this.warnings.delete(target.code);
        } else {
          this.warnings.set(target.code, true);
          this.logger.warn(`ipx800: the command on ${shownCode(target.code)} did not take effect`);
        }
        this.pendingWrites.delete(target.code);
      }
      const guard = this.guards.get(target.code);
      if (guard && !guard.inFlight && at > guard.sentAt) {
        this.checkGuard(guard, target.value, resend);
      }
    }
  }

  /** A guard against a value read after its last send. */
  checkGuard(guard, value, resend) {
    if (value === undefined) {
      // Unknown is never "changed elsewhere".
      return;
    }
    if (value === guard.value) {
      guard.confirmed = true;
      guard.other = undefined;
      return;
    }
    if (guard.confirmed) {
      if (guard.other === value) {
        // Another value read twice in a row: changed on the IPX itself (its scenarios, its page).
        this.guards.delete(guard.code);
        this.logger.info(`ipx800: ${shownCode(guard.code)} changed on the IPX, no longer held`);
        return;
      }
      guard.other = value;
      return;
    }
    if (resend && guard.resends < TIMINGS.resendMax) {
      this.resendGuard(guard);
    }
  }

  /** Sends a guard again (no ack): protective priority, counted when it leaves. */
  resendGuard(guard) {
    const client = this.client;
    const target = this.targetOf(guard.code);
    if (!client || !target || guard.inFlight) return;
    guard.inFlight = true;
    const deadline = this.monotonic() + TIMINGS.requestTimeout;
    this.write(client, target, guard.value, PRIORITY.PROTECTIVE, {
      deadline,
      beforeSend: () => {
        // A newer command that left meanwhile (or another protective one): never sent over it.
        if (this.guards.get(guard.code) !== guard) {
          throw new IpxError('late', 'superseded');
        }
      },
      onSent: () => {
        // Counted once it has left (a try that never left is not a resend).
        guard.resends += 1;
        guard.sentAt = this.monotonic();
      },
    })
      .catch((err) => {
        this.logger.warn(`ipx800: ${shownCode(guard.code)} sent again: ${errorReason(err)}`);
      })
      .finally(() => {
        guard.inFlight = false;
        this.saveMemory().catch(() => {});
      });
    this.logger.info(`ipx800: ${shownCode(guard.code)} sent again`);
  }

  // --- Gladys --------------------------------------------------------------------

  createdDevices() {
    const selector = this.gladys.selector;
    return (this.gladys.devices ?? []).filter((d) => parseExternalId(d.external_id, selector));
  }

  createdFeatures() {
    return new Map(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => [f.external_id, f])),
    );
  }

  /** The devices to publish: the targets known, plus those created in Gladys (never dropped). */
  async publishDevices() {
    const created = new Map();
    for (const device of this.createdDevices()) created.set(device.external_id, device);
    const devices = [];
    const seen = new Set();
    for (const target of this.model.values()) {
      const ids = idsOf(this.gladys, target.kind, target.code);
      seen.add(ids.device);
      devices.push(
        buildDevice(this.gladys, target, {
          language: this.config.language,
          relayKind: this.config.relays.get(target.code),
          created: created.get(ids.device),
        }),
      );
    }
    for (const [id, device] of created) {
      if (!seen.has(id)) devices.push(device);
    }
    if (devices.length === 0) return;
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** Queues the states of a target read, for the features created in Gladys only. */
  queueStates(target, created = this.createdFeatures()) {
    const ids = idsOf(this.gladys, target.kind, target.code);
    const keys = new Set(
      [F.READONLY, F.SWITCH, F.LIGHT].filter((key) => created.has(ids.feature(key))),
    );
    for (const [key, state] of targetStates(target, keys)) {
      const id = ids.feature(key);
      if (created.has(id)) this.publisher.push(id, state);
    }
  }

  /**
   * A device created (or updated): its last values at once, only when fresh
   * (read by a round younger than an interval, no failure since).
   */
  async deviceCreated(device) {
    const parsed = parseExternalId(device?.external_id, this.gladys.selector);
    const target = parsed && this.model.get(parsed.code);
    const mono = this.monotonic();
    if (
      target &&
      target.at !== undefined &&
      !this.offline &&
      this.pauseLeft(mono) === 0 &&
      mono - target.at <= this.interval + TIMINGS.roundBudget
    ) {
      const created = this.createdFeatures();
      for (const f of device?.features ?? []) created.set(f.external_id, f);
      this.queueStates(target, created);
      await this.flush();
    }
  }

  async deviceDeleted(device) {
    if (device?.external_id) this.publisher.forget(device.external_id);
  }

  /** The Discovery tab asks for a scan: a round now when it is due, else the last list. */
  async scan() {
    if (this.client && !this.running) {
      const mono = this.monotonic();
      if (mono >= this.dueAt(mono) && !this.refusedApplies()) {
        await this.tick();
        return;
      }
    }
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button -------------------------------------------------------

  async testConnection() {
    const missing = this.configMessage();
    if (missing) return missing;
    if (!this.client) return T.connecting;
    const mono = this.monotonic();
    if (mono - this.lastTestAt < TIMINGS.testCooldown) {
      return this.lastMessage ?? T.connecting;
    }
    this.lastTestAt = mono;
    if (this.running) return T.test.busy;
    const due = this.dueAt(mono);
    if (mono < due) {
      return join(T.test.wait(age(due - mono)), this.lastMessage ?? T.connecting);
    }
    let handle;
    const budget = new Promise((resolve) => {
      handle = this.timers.setTimeout(() => resolve('slow'), TIMINGS.testBudget);
    });
    const result = await Promise.race([
      this.tick({ evenRefused: true }).then(() => 'done'),
      budget,
    ]);
    this.timers.clearTimeout(handle);
    if (result === 'slow') return T.test.slow;
    return this.lastMessage ?? T.connecting;
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /** The target of a code: from the last round, the configuration (V4) or /data (V5). */
  targetOf(code) {
    return this.model.get(code);
  }

  /** One write through the lane; resolves when the IPX accepted it. */
  write(client, target, value, priority, hooks) {
    if (this.config.version === 'v4') {
      const query = v4WriteQuery(target, value, V4_FP_CODE.get(value));
      if (!query) return Promise.reject(new IpxError('bad_request', 'invalid write'));
      return client.v4Write(query, priority, hooks);
    }
    const io = v5Write(target, value);
    if (!io) return Promise.reject(new IpxError('bad_request', 'invalid write'));
    return client.v5Write(io.id, io.on, priority, hooks);
  }

  /**
   * A read of the IPX that leaves after this call (shared by the commands
   * asking for one before it leaves): `{ values: Map(code -> value), at }`.
   */
  readBack(priority, deadline, { resend = false, after = Infinity } = {}) {
    const job = this.readBackJob;
    // Shared when it leaves after the caller's write: not left yet, or asked after that write was answered.
    if (
      job &&
      job.priority <= priority &&
      job.client === this.client &&
      (!job.started || job.createdAt >= after)
    ) {
      return job.promise;
    }
    const client = this.client;
    const generation = this.generation;
    const next = { started: false, priority, client, createdAt: this.monotonic() };
    next.promise = (async () => {
      let at;
      const hooks = {
        deadline,
        onSent: () => {
          next.started = true;
          at = this.monotonic();
        },
      };
      const values = new Map();
      if (this.config.version === 'v4') {
        const parsed = parseV4(await client.v4ReadAll(priority, hooks), this.model.keys());
        if (parsed.error)
          throw new IpxError(parsed.error, 'not an IPX800 V4 answer', { sent: true });
        for (const [code, target] of parsed.targets) values.set(code, target.value);
      } else {
        const parsed = parseV5Values(await client.v5Io(priority, hooks), undefined);
        if (parsed.error)
          throw new IpxError(parsed.error, 'not an IPX800 V5 answer', { sent: true });
        for (const [code, target] of this.model) {
          if (target.kind !== KINDS.THL) values.set(code, v5Value(target, parsed));
        }
      }
      if (generation === this.generation) this.storeReadBack(values, at, resend);
      return { values, at };
    })();
    next.promise
      .catch(() => {})
      .finally(() => {
        if (this.readBackJob === next) this.readBackJob = undefined;
      });
    this.readBackJob = next;
    return next.promise;
  }

  /** The values of a read back into the model (relays, inputs, zones), then the checks. */
  storeReadBack(values, at, resend) {
    for (const [code, value] of values) {
      const target = this.model.get(code);
      if (target && value !== undefined) {
        this.model.set(code, { ...target, value, at });
      }
    }
    this.applyRead(at, { resend });
  }

  /** A command from Gladys. */
  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const parsed = parseExternalId(feature?.external_id, this.gladys.selector);
    if (!parsed || ![F.SWITCH, F.LIGHT, F.MODE].includes(parsed.key)) {
      throw this.refusal(parsed?.key === F.READONLY ? ERRORS.readOnly : ERRORS.notCommandable);
    }
    if (!this.configLoaded) throw this.refusal(ERRORS.configNotLoaded);
    if (!this.client) throw this.refusal(ERRORS.noConfig);
    const wanted = integerOf(value);
    const kind = parsed.kind;
    if (kind === KINDS.RELAY) {
      if (wanted !== 0 && wanted !== 1) throw this.refusal(ERRORS.badValue);
      if (!this.config.relays.has(parsed.code)) throw this.refusal(ERRORS.readOnly);
    } else if (kind === KINDS.PILOT) {
      if (wanted === undefined || !V4_FP_CODE.has(wanted)) throw this.refusal(ERRORS.badValue);
    } else {
      throw this.refusal(ERRORS.notCommandable);
    }
    const target = this.targetOf(parsed.code);
    if (!target || target.kind !== kind) throw this.refusal(ERRORS.unknownTarget);
    if (isProtective(kind, wanted)) {
      return this.protective(target, wanted, received);
    }
    // Not protective: the option, the pause, the key, a stop on the way, the room.
    if (kind === KINDS.PILOT && !this.config.allowHeatingModes) {
      throw this.refusal(ERRORS.heatingDisabled);
    }
    this.checkNotPaused(received);
    if (this.guards.get(target.code)?.userInFlight) throw this.refusal(ERRORS.stopPending);
    if (this.commands.length >= LIMITS.commandQueue) throw this.refusal(ERRORS.queueFull);
    const ahead = this.commands.length + (this.serving ? 1 : 0);
    return new Promise((resolve, reject) => {
      this.commands.push({
        code: target.code,
        kind,
        wanted,
        received,
        ahead,
        seq: this.seq,
        resolve,
        reject,
      });
      this.serveCommands();
    });
  }

  checkNotPaused(mono) {
    if (this.refusedApplies()) throw this.refusal(ERRORS.keyRefused);
    if (this.pause && this.pauseLeft(mono) > 0) {
      throw this.refusal(
        ERRORS.paused(
          this.lastReason ?? both('earlier reads failed', 'les lectures précédentes ont échoué'),
        ),
      );
    }
  }

  serveCommands() {
    if (this.serving) return this.serving;
    this.serving = (async () => {
      while (this.commands.length > 0) {
        const job = this.commands.shift();
        try {
          // The turn ends once the write is answered: the read back is awaited outside it.
          const { confirmation } = await this.command(job);
          confirmation.then(job.resolve, job.reject);
        } catch (err) {
          job.reject(err);
        }
      }
    })().finally(() => {
      this.serving = undefined;
      if (this.commands.length > 0) this.serveCommands();
    });
    return this.serving;
  }

  /** The checks right before a non-protective command leaves, on the configuration of now. */
  checkBeforeSend(job, generation, client) {
    if (generation !== this.generation || this.client !== client) {
      throw this.refusal(ERRORS.unknownTarget);
    }
    if (job.kind === KINDS.PILOT && !this.config.allowHeatingModes) {
      throw this.refusal(ERRORS.heatingDisabled);
    }
    if (job.kind === KINDS.RELAY && !this.config.relays.has(job.code)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const guard = this.guards.get(job.code);
    if (guard && (guard.userInFlight || guard.seq > job.seq)) {
      // A protective command came after this one: this one never leaves after it.
      throw this.refusal(ERRORS.cancelledByStop);
    }
    this.checkNotPaused(this.monotonic());
    if (this.monotonic() >= job.received + TIMINGS.commandSendBy) {
      throw this.refusal(ERRORS.late(job.ahead));
    }
  }

  /** A non-protective command, in its turn: resolves, once written, with the promise of its confirmation. */
  async command(job) {
    const generation = this.generation;
    const client = this.client;
    const target = this.targetOf(job.code);
    if (!client || !target) throw this.refusal(ERRORS.unknownTarget);
    this.checkBeforeSend(job, generation, client);
    // A guard of the target is lifted by this command once it has left; a
    // heating mode needs that written to /data before its first byte.
    const guard = this.guards.get(job.code);
    if (job.kind === KINDS.PILOT) {
      if (guard) this.guards.delete(job.code);
      const saved = await this.saveMemory();
      if (!saved) {
        if (guard) this.guards.set(job.code, guard);
        throw this.refusal(ERRORS.saveFailed);
      }
      if (generation !== this.generation) throw this.refusal(ERRORS.unknownTarget);
      if (guard) this.guards.set(job.code, guard);
    }
    let left = false;
    const restoreGuard = () => {
      if (guard && !this.guards.has(job.code)) this.guards.set(job.code, guard);
    };
    try {
      await this.write(client, target, job.wanted, PRIORITY.COMMAND, {
        deadline: job.received + TIMINGS.commandAnswerBy,
        beforeSend: () => this.checkBeforeSend(job, generation, client),
        onSent: () => {
          left = true;
          // A newer command that left: the guard of this target ends here.
          if (this.guards.get(job.code) === guard) this.guards.delete(job.code);
          this.pendingWrites.set(job.code, {
            expected: job.wanted,
            at: this.monotonic(),
          });
        },
      });
    } catch (err) {
      if (left && err instanceof IpxError && ['refused', 'busy', 'http'].includes(err.code)) {
        // Refused by the IPX: not a newer command, the guard stands.
        restoreGuard();
        this.pendingWrites.delete(job.code);
      }
      if (left) this.afterWrite(generation);
      this.saveMemory().catch(() => {});
      throw this.commandError(err, left, job.ahead);
    }
    this.saveMemory().catch(() => {});
    this.afterWrite(generation);
    const confirmation = this.confirm(
      job.code,
      job.kind,
      job.wanted,
      job.received,
      PRIORITY.CONFIRM,
    );
    confirmation.catch(() => {});
    // Wrapped: an async function would otherwise wait for it.
    return { confirmation };
  }

  /** The error of a write: never "not sent" once it may have left. */
  commandError(err, left, ahead) {
    if (!(err instanceof IpxError)) return err;
    if (!left || !err.sent) {
      if (err.code === 'late') return this.refusal(ERRORS.late(ahead));
      if (err.code === 'cut') return this.refusal(ERRORS.cut);
      if (err.code === 'bad_request') return this.refusal(ERRORS.badValue);
      return this.refusal(ERRORS.notSent(reasonOf(err)));
    }
    if (err.code === 'refused') return this.refusal(ERRORS.keyRefused);
    if (err.code === 'not_success' || err.code === 'http' || err.code === 'busy') {
      return this.refusal(ERRORS.rejected);
    }
    return this.refusal(ERRORS.unconfirmed);
  }

  /**
   * The read back of a command that left: the value asked = done; the
   * value before = not applied yet; nothing in time = sent, unconfirmed.
   */
  async confirm(code, kind, wanted, received, priority) {
    // The write was answered now: a read asked from now on leaves after it.
    const after = this.monotonic();
    let read;
    if (priority !== PRIORITY.PROTECTIVE) {
      // The commands waiting are written first (a scene): one read back then serves them all.
      await this.serving?.catch(() => {});
    }
    try {
      read = await this.readBack(priority, received + TIMINGS.commandAnswerBy, { after });
    } catch {
      throw this.refusal(ERRORS.unconfirmed);
    }
    await this.refreshStatus();
    const value = read.values.get(code);
    if (value === wanted) return undefined;
    if (value === undefined) throw this.refusal(ERRORS.unconfirmed);
    throw this.refusal(ERRORS.notApplied(describe(kind, value), describe(kind, wanted)));
  }

  /** After a write that left: reads again 5 s and 20 s later (never skipped). */
  afterWrite(generation) {
    for (const delay of TIMINGS.followUps) {
      const timer = this.timers.setTimeout(() => {
        this.followUps.delete(timer);
        if (generation !== this.generation || !this.client) return undefined;
        return this.readBack(PRIORITY.CONFIRM, this.monotonic() + TIMINGS.requestTimeout, {
          resend: true,
        })
          .then(() => this.refreshStatus())
          .catch((err) => this.logger.warn(`ipx800: follow-up read failed: ${errorReason(err)}`));
      }, delay);
      this.followUps.add(timer);
    }
  }

  /**
   * A protective command: no option, pause, refused key nor queue stops it.
   * It cancels the commands of the target still waiting, cuts the request in
   * flight, is tried again for 250 ms, and stays as a guard (in /data) sent
   * again by the reads until they show it.
   */
  async protective(target, wanted, received) {
    const client = this.client;
    const generation = this.generation;
    const code = target.code;
    for (const job of [...this.commands]) {
      if (job.code === code) {
        this.commands.splice(this.commands.indexOf(job), 1);
        job.reject(this.refusal(ERRORS.cancelledByStop));
      }
    }
    this.seq += 1;
    const guard = {
      code,
      kind: target.kind,
      value: wanted,
      resends: 0,
      confirmed: false,
      other: undefined,
      seq: this.seq,
      sentAt: -Infinity,
      inFlight: true,
      userInFlight: true,
    };
    this.guards.set(code, guard);
    // Written to /data without waiting: a protective command never waits for the disk.
    this.saveMemory().catch(() => {});
    this.logger.info(
      `ipx800: ${shownCode(code)} -> ${describe(target.kind, wanted).en} (protective)`,
    );
    const sendBy = received + TIMINGS.commandSendBy;
    let left = false;
    let lastError;
    const first = this.monotonic();
    for (;;) {
      try {
        await this.write(client, target, wanted, PRIORITY.PROTECTIVE, {
          deadline: received + TIMINGS.commandAnswerBy,
          beforeSend: () => {
            if (this.monotonic() >= sendBy) throw new IpxError('late', 'no time left to send');
          },
          onSent: () => {
            left = true;
            guard.sentAt = this.monotonic();
          },
        });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        const mono = this.monotonic();
        if (
          left ||
          !(err instanceof IpxError) ||
          generation !== this.generation ||
          mono - first >= TIMINGS.protectiveRetry ||
          mono >= sendBy
        ) {
          break;
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.protectiveRetryGap));
      }
    }
    guard.inFlight = false;
    guard.userInFlight = false;
    this.saveMemory().catch(() => {});
    if (!left) {
      // Kept: the reads send it again when they show another value.
      throw this.refusal(ERRORS.protectiveKept(reasonOf(lastError)));
    }
    this.afterWrite(generation);
    if (lastError) {
      throw this.commandError(lastError, true, 0);
    }
    return this.confirm(code, target.kind, wanted, received, PRIORITY.PROTECTIVE);
  }
}
