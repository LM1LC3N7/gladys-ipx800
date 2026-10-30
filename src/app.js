// -----------------------------------------------------------------------------
// One IPX800 of the configuration (a slot: src/hub.js runs up to three), read
// every poll interval through its local HTTP API; one Gladys device per
// relay, digital input, pilot-wire zone and X-THL; the commands; the "Test
// the connection" button. index.js only wires the SDK handlers. No command
// goes to, and no value comes from, an IPX800 other than the one the devices
// of the slot belong to (see "Identity" below).
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
// 15 s, then every minute), at every connection to Gladys, and at once (2 s
// apart at most) when a command comes before it. The configurations apply
// one at a time, in order, the last one winning (one client, one lane).
//
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces
// the reads, the pauses, the deadlines and the publication budget. The clock
// is read once per decision (`dueAt(mono)` computes on the caller's instant).
//
// Commands (one lane of requests to the IPX, see src/ipx/client.js):
//   - protective: pilot wire Off and Frost protection, a listed relay
//     switched off. Never refused by the heating option, a pause, a refused
//     key, the queue, a read, a read back or a command in progress, nor
//     before the first read (the V5 ids are kept in /data). Clicked, they
//     cut any request in flight but another clicked one, cancel the
//     commands of the same target still waiting, are tried again for
//     250 ms, then kept (a guard, in /data) and sent again as soon as the
//     lane is free, and by the reads that contradict them (3 times at most).
//     Clicked before the configuration is read, they ask for it at once and
//     are kept in memory until it comes. A guard is lifted by a later
//     command on the target that left (a click), by another protective
//     command, by the relay leaving the list, or once confirmed, by another
//     value read twice in a row (changed on the IPX itself, not an older
//     command of ours handled late); never by the time. A newer click on the
//     target stops the tries of an older one right before their first byte.
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
  MULTI,
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
  parseMac,
  parseV4,
  parseV5Layout,
  parseV5Values,
  v4Codes,
  v4Kind,
  v4WriteQuery,
  v5FromKept,
  v5Kept,
  v5Fault,
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

/** The salted id of a MAC address kept in /data (never the address itself). */
export const macId = (salt, mac) =>
  createHash('sha256')
    .update(`ipx800-mac\u0000${salt}\u0000${mac}`, 'utf8')
    .digest('hex')
    .slice(0, 32);

/** Codes only a V5 has (its extensions by IPX id), only a V4 has (FP, THL, R9+, D9+). */
const V5_ONLY = (code) => /^(x8r|x8d|x24d|x4fp|xthl)\d/.test(code);
const V4_ONLY = (code) =>
  /^(fp|thl)\d/.test(code) || (/^[rd]\d+$/.test(code) && Number(code.slice(1)) > 8);

/** The errors of a round after which the IPX may answer the API of the other model. */
const OTHER_MODEL_CODES = ['http', 'bad_response', 'refused', 'not_success', 'size'];

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
    slot = 1,
    publisher,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.random = random;
    /** Which IPX800 of the configuration (1 to SLOTS): its ids and its /data file. */
    this.slot = slot;
    // The budget of 300 states a minute counts on the monotonic clock; shared by the slots
    // when given (src/hub.js starts and stops it then).
    this.ownPublisher = !publisher;
    this.publisher = publisher ?? new StatePublisher({ gladys, logger, now: monotonic, timers });
    /**
     * Is the IPX800 read the one the devices of this slot were made for (the owner in /data)?
     * 'same'; 'pending' (V5 at start: its MAC being read); 'unverified' (V5 whose MAC could
     * not be read); 'different' (another IPX800: nothing sent, its kept Offs dropped);
     * 'unbound' (devices whose IPX800 is not known for sure: nothing sent); 'presumed' (devices
     * of 0.1.2: the last controller it read, unconfirmed: Offs only, to that address).
     */
    this.verdict = 'unbound';
    /** The identity of the last round: { kind: 'mac', id, label } | { kind: 'address', id }. */
    this.seen = undefined;
    this.identityCheck = undefined;
    /** The first click of "Attach the devices": { at, id }. */
    this.attachAsk = undefined;
    /** 'v4' | 'v5': the model the IPX answers while the other one is configured. */
    this.wrongModel = undefined;
    this.config = normalizeConfig();
    this.configLoaded = false;
    this.configTries = 0;
    this.configTimer = undefined;
    this.configGeneration = 0;
    this.memory = emptyMemory();
    this.storeUnreadable = false;
    /** No file, devices there, and the first save failed: owner unknown (see startNow). */
    this.storeLost = false;
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
    /**
     * code -> guard of a protective command: { code, kind, value, resends, confirmed, other,
     * seq, sentAt, inFlight, stale }. `stale`: an older write of ours on the target that had
     * left without an answer when the guard came (it may still land after it).
     */
    this.guards = new Map();
    /** code -> the last write that left: { value, sentAt, answered } (memory only). */
    this.lastWrites = new Map();
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
    /** The configurations, applied one at a time (the last one queued wins). */
    this.lifecycle = Promise.resolve();
    this.configSeq = 0;
    /** True once a start ended (client created, or nothing to start): commands wait for it. */
    this.ready = false;
    this.readyWaiters = new Set();
    this.lastConfigAsk = -Infinity;
    this.configLoading = undefined;
    /** code -> { kind, value }: protective commands clicked before the configuration was read. */
    this.pendingProtectives = new Map();
    /** Codes of protective commands kept for the configuration, then unknown or not listed. */
    this.droppedPending = new Set();
    this.memoryLoaded = false;
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

  loadConfig() {
    if (!this.configLoading) {
      this.configLoading = this.loadConfigNow().finally(() => {
        this.configLoading = undefined;
      });
    }
    return this.configLoading;
  }

  /** A command came before the configuration: read it now, or 2 s after the last read at most. */
  askConfig() {
    if (!this.configLoader || this.configLoading) {
      return;
    }
    const wait = Math.max(0, this.lastConfigAsk + TIMINGS.configAskGap - this.monotonic());
    this.clearConfigTimer();
    this.configTimer = this.timers.setTimeout(() => {
      this.configTimer = undefined;
      return this.loadConfig().catch(() => {});
    }, wait);
  }

  async loadConfigNow() {
    const generation = ++this.configGeneration;
    this.lastConfigAsk = this.monotonic();
    let raw;
    try {
      raw = await this.configLoader();
    } catch (err) {
      if (generation !== this.configGeneration) {
        return;
      }
      // A protective command waits for it: the shortest retry, whatever failed before.
      const wait =
        this.pendingProtectives.size > 0
          ? TIMINGS.configRetry[0]
          : TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger.warn(
        `ipx800: configuration not read (${err?.name ?? 'Error'}); new try in ${Math.round(wait / 1000)} s`,
      );
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.loadConfig().catch(() => {});
      }, wait);
      // Not awaited: a slow Gladys never delays the next read of the configuration.
      this.setStatus(false, T.configNotRead(age(wait))).catch(() => {});
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
  connected(raw = {}) {
    return this.enqueue(raw, true);
  }

  /** A configuration saved by the user. */
  configUpdated(raw = {}) {
    return this.enqueue(raw, false);
  }

  /**
   * One configuration at a time, in order: a configuration superseded by a
   * newer one still waiting is skipped (the last one wins); a reconnection
   * still resends what Gladys keeps in memory only.
   */
  enqueue(raw, reconnection) {
    const seq = ++this.configSeq;
    const job = async () => {
      if (seq === this.configSeq) {
        if (reconnection) await this.connectedNow(raw);
        else await this.configUpdatedNow(raw);
      } else if (reconnection && this.started) {
        await this.resendToGladys();
      }
    };
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch((err) =>
      this.logger.error(`ipx800: configuration not applied (${err?.name ?? 'Error'})`),
    );
    return this.lifecycle;
  }

  async connectedNow(raw = {}) {
    if (!this.started || !this.configLoaded) {
      this.configLoaded = true;
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdatedNow(raw);
    await this.resendToGladys();
  }

  /** Gladys restarted: the status and the Discovery list again; the values at the next read. */
  async resendToGladys() {
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
    } finally {
      this.setReady();
    }
  }

  setReady() {
    this.ready = true;
    for (const resolve of this.readyWaiters) resolve(true);
    this.readyWaiters.clear();
  }

  /** Resolves true once a start ended, false at `deadline` (monotonic). */
  waitReady(deadline) {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        this.timers.clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = this.timers.setTimeout(
        () => done(false),
        Math.max(0, deadline - this.monotonic()),
      );
      this.readyWaiters.add(done);
    });
  }

  async startNow(raw = {}) {
    this.ready = false;
    // Nothing goes to /data until this start has read it back.
    this.memoryLoaded = false;
    this.stop();
    const generation = this.generation;
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
    if (generation !== this.generation) return;
    this.adoptMemory(normalizeMemory(loaded, now), now, mono);
    this.memoryLoaded = true;
    if (!this.memory.salt && !this.storeUnreadable) this.memory.salt = this.random();
    // No file, devices there, and /data cannot be written (never could, say): the owner of the
    // devices is not known, as with a file that cannot be read (never "lost": Offs still go).
    this.storeLost = false;
    if (loaded === null && !this.storeUnreadable && this.createdDevices().length > 0) {
      this.storeLost = !(await this.saveMemory());
      if (generation !== this.generation) return;
    }
    if (this.ownPublisher) this.publisher.start();
    const missing = this.configMessage();
    if (missing) {
      this.verdict = 'unbound';
      await this.setStatus(false, missing);
      // Nothing read: the Discover list of the previous configuration goes.
      await this.publishDevices();
      return;
    }
    // Which IPX800 the devices of this slot belong to, before anything is sent: from /data
    // and the configuration (a V5 owner is checked by its MAC first, see below).
    this.verdict = this.verdictAtStart();
    if (this.verdict === 'different') this.dropGuards('another IPX800 is configured');
    // Kept for an IPX800 that is not this one, or not known for sure: never sent (a 0.1.2 file
    // whose devices cannot be this model's, say).
    if (this.verdict === 'unbound' && !this.ownerUnknown) this.dropGuards('owner not known');
    this.client = new IpxClient({
      version: this.config.version,
      host: this.config.host,
      port: this.config.port,
      apiKey: this.config.apiKey,
      transport: this.transport,
      monotonic: this.monotonic,
      timers: this.timers,
    });
    // The key is known: before any call to Gladys, the protective commands leave. Those
    // clicked before the configuration was read, then those kept in /data and not seen
    // applied (after a restart or a new configuration), before the first read. The clicks
    // first, at their priority: no guard of /data starts before them only to be cut.
    const clicked = new Set(this.adoptPendingProtectives());
    const kept = [...this.guards.values()].filter((guard) => !clicked.has(guard));
    const sendKept = () => {
      for (const guard of [...clicked, ...kept]) {
        if (clicked.has(guard)) {
          this.resendGuard(guard, PRIORITY.PROTECTIVE);
        } else if (!guard.confirmed && guard.resends < TIMINGS.resendMax) {
          this.resendGuard(guard);
        }
      }
    };
    if (this.verdict === 'pending') {
      // A V5 owner: its MAC first (one request); an Off kept for it never reaches another one.
      const client = this.client;
      this.identityCheck = this.checkIdentity(client, generation).then(() => {
        if (generation === this.generation) sendKept();
      });
    } else {
      sendKept();
    }
    // Commands (a click waiting) may go from now on.
    this.setReady();
    await this.saveMemory();
    if (generation !== this.generation) return;
    if (this.refusedApplies()) {
      await this.setStatus(false, T.refused);
    } else if (['different', 'unbound', 'presumed'].includes(this.verdict)) {
      // Known before any read: said at once, not at the next round.
      await this.setStatus(false, this.statusMessage());
    } else {
      await this.setStatus(false, this.pause ? this.pauseMessage(mono) : T.connecting);
    }
    await this.publishDevices();
    if (generation !== this.generation) return;
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
      this.guards.set(g.code, this.makeGuard(g, mono));
    }
    // A relay no longer listed is never driven again, not even by a guard kept in /data.
    this.dropUnlistedGuards();
  }

  /** Drops the guards of the relays not listed now; true when one was dropped. */
  dropUnlistedGuards() {
    let dropped = false;
    for (const [code, guard] of this.guards) {
      if (guard.kind === KINDS.RELAY && !this.config.relays.has(code)) {
        this.guards.delete(code);
        dropped = true;
        this.logger.info(`ipx800: ${shownCode(code)} no longer listed: not held any more`);
      }
    }
    return dropped;
  }

  /** The protective commands clicked before the configuration was read become guards. */
  adoptPendingProtectives() {
    const adopted = [];
    for (const [code, { kind, value, waiting }] of this.pendingProtectives) {
      // A click still waiting sends it itself.
      if (waiting) continue;
      this.pendingProtectives.delete(code);
      const target = this.model.get(code);
      const unlisted = kind === KINDS.RELAY && !this.config.relays.has(code);
      const other = !this.mayDrive(true);
      if (!target || target.kind !== kind || unlisted || other) {
        // Told, never dropped silently: the ack said it would be sent.
        this.droppedPending.add(code);
        this.logger.warn(
          `ipx800: ${shownCode(code)} clicked before the configuration: not sent (${other ? 'not the IPX800 of the devices' : unlisted ? 'relay not listed' : 'unknown on this IPX800'})`,
        );
        continue;
      }
      this.seq += 1;
      const guard = this.makeGuard({ code, kind, value, seq: this.seq });
      this.guards.set(code, guard);
      adopted.push(guard);
      this.logger.info(`ipx800: ${shownCode(code)} clicked before the configuration: sent now`);
    }
    return adopted;
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const timer of this.followUps) {
      this.timers.clearTimeout(timer);
    }
    this.followUps.clear();
    if (this.ownPublisher) this.publisher.stop();
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
    this.droppedPending.clear();
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
    this.seen = undefined;
    this.identityCheck = undefined;
    this.attachAsk = undefined;
    this.wrongModel = undefined;
  }

  configMessage() {
    if (this.config.duplicateOf !== undefined) return T.duplicateSlot(this.config.duplicateOf);
    if (this.config.addressError === 'path') return T.addressPath;
    if (this.config.addressError === 'https') return T.addressHttps;
    if (this.config.addressError === 'invalid') return T.addressInvalid;
    if (this.config.apiKeyInvalid) return T.apiKeyInvalid;
    return isComplete(this.config) ? undefined : T.noConfig;
  }

  /** A new controller or key: start again; the rest applies at once. */
  async configUpdatedNow(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    this.clearConfigTimer();
    if (!this.started || !this.configLoaded || sessionKey(next) !== sessionKey(previous)) {
      this.started = true;
      this.configLoaded = true;
      return this.start(raw);
    }
    this.config = next;
    if (this.dropUnlistedGuards()) {
      await this.saveMemory();
    }
    if (next.allowHeatingModes !== previous.allowHeatingModes) {
      this.logger.info(`ipx800: heating modes ${next.allowHeatingModes ? 'allowed' : 'off'}`);
    }
    if (next.pollInterval !== previous.pollInterval) {
      this.schedule();
    }
    this.published = undefined;
    await this.publishDevices();
    if (this.round && !this.offline && !this.refusedApplies()) {
      await this.setStatus(this.statusConnected(), this.statusMessage());
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
    if (!this.memoryLoaded) {
      // Between the reset of a start and its read of /data: never written over.
      return false;
    }
    if (this.storeUnreadable) {
      // Read again first: what it holds is never overwritten unseen.
      try {
        const loaded = normalizeMemory(await this.store.load(), this.now());
        this.storeUnreadable = false;
        // The owner and its salt are the file's: none was set while it could not be read.
        this.memory.owner = loaded.owner;
        this.memory.salt = loaded.salt || this.memory.salt || this.random();
        if (loaded.key === this.config.key) {
          for (const g of loaded.guards) {
            if (!this.guards.has(g.code)) {
              this.guards.set(g.code, this.makeGuard(g));
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
      this.storeLost = false;
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
      if (err instanceof IpxError && (err.code === 'cut' || (err.code === 'late' && !err.sent))) {
        // Cut by a protective command, or never sent (left the queue behind commands at its
        // deadline): not a failure of the IPX; the next round at its time.
        this.schedule();
        return;
      }
      // An answer, but not of the model configured: is it the other model (a V4 typed V5)?
      const other =
        err instanceof IpxError && OTHER_MODEL_CODES.includes(err.code)
          ? await client.otherModel(PRIORITY.READ, {
              deadline: this.monotonic() + TIMINGS.requestTimeout,
            })
          : undefined;
      if (gone()) return;
      await this.failed(err, mono, other);
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
      // A V4 gives no MAC address in its API: it is known by its address (the controller key).
      return { targets: parsed.targets, at, unreadTypes: [], seen: this.seenOf() };
    }
    // The MAC first: which IPX800 this is, read again every round.
    let mac;
    try {
      mac = parseMac(await client.v5Info(PRIORITY.READ, hooks()));
    } catch (err) {
      if (
        !(err instanceof IpxError) ||
        ['cut', 'busy', 'network', 'timeout'].includes(err.code) ||
        (err.code === 'late' && !err.sent)
      ) {
        throw err;
      }
      // An answer without it (an older firmware, say): unreadable, never "another IPX800".
    }
    const ipx = await client.v5Ipx(PRIORITY.READ, hooks());
    const extensions = new Map();
    const unreadTypes = [];
    for (const type of V5_EXTENSIONS) {
      try {
        extensions.set(type, await client.v5Extensions(type, PRIORITY.READ, hooks()));
      } catch (err) {
        if (
          !(err instanceof IpxError) ||
          ['cut', 'busy'].includes(err.code) ||
          (err.code === 'late' && !err.sent)
        ) {
          throw err;
        }
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
      if (
        !(err instanceof IpxError) ||
        ['cut', 'busy'].includes(err.code) ||
        (err.code === 'late' && !err.sent)
      ) {
        throw err;
      }
      ana = [];
      unreadTypes.push('ana');
    }
    const values = parseV5Values(io, ana);
    if (values.error) throw new IpxError(values.error, 'not an IPX800 V5 answer', { sent: true });
    const targets = new Map();
    for (const [code, target] of layout.targets) {
      targets.set(code, {
        ...target,
        value: v5Value(target, values),
        ...(target.kind === KINDS.THL ? { fault: v5Fault(target, values) } : {}),
      });
    }
    // The types not read this time: the targets read before, still known, not fresh.
    for (const [code, target] of this.model) {
      const type = /^(x8r|x8d|x24d|x4fp|xthl)\d/.exec(code)?.[1];
      if (!targets.has(code) && type && !layout.types.has(type)) {
        // Its ids were not checked in this round: no value from them.
        targets.set(code, { ...target, value: undefined, fault: undefined });
      }
    }
    return { targets, at, unreadTypes, seen: this.seenOf(mac) };
  }

  async succeeded({ targets, at, unreadTypes, seen }) {
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastReason = undefined;
    this.wrongModel = undefined;
    if (this.memory.refused) {
      this.memory.refused = null;
      this.logger.info('ipx800: the IPX accepts the API key again');
    }
    this.model = new Map();
    for (const [code, target] of targets) {
      this.model.set(code, { ...target, at });
    }
    this.round = { unreadTypes };
    // Which IPX800 answered, against the owner of the devices, before anything is published.
    this.seen = seen;
    this.applyVerdict(this.judge(seen));
    this.applyRead(at);
    await this.saveMemory();
    await this.setStatus(this.statusConnected(), this.statusMessage());
    await this.publishDevices();
    await this.flush();
  }

  /** The round failed: a pause; a refused key stops the reads; `other`: the IPX is of the other model. */
  async failed(err, mono, other) {
    if (other) {
      // Not a refused key nor an outage: the model typed is not this IPX800's. A pause as a
      // failure (the user changes the model), nothing published from it.
      const wait = Math.max(
        this.interval,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.failures += 1;
      this.setPause(mono, wait, 'failed');
      this.offline = true;
      this.wrongModel = other;
      this.lastReason = T.wrongModelReason(this.config.version, other);
      this.logger.warn(
        `ipx800: this IPX800 answers the ${other.toUpperCase()} API, ${this.config.version.toUpperCase()} is configured`,
      );
      await this.saveMemory();
      await this.setStatus(false, T.wrongModel(this.config.version, other));
      await this.publishDevices();
      return;
    }
    this.wrongModel = undefined;
    if (err instanceof IpxError && err.code === 'refused') {
      const salt = this.random();
      this.memory.refused = { salt, tag: tagOf(salt, this.config.apiKey) };
      this.offline = true;
      this.lastReason = reasonOf(err);
      this.logger.warn('ipx800: the IPX refused the API key; no read until it changes');
      await this.saveMemory();
      await this.setStatus(false, T.refused);
      await this.publishDevices();
      return;
    }
    // No answer: the IPX800 may be replaced before the next read; an Off reads its MAC first.
    this.recheck();
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
    // An IPX800 that does not answer: its devices leave the Discover list until it does.
    await this.publishDevices();
  }

  /**
   * Connected for Gladys, and its values published onto the devices: the IPX800 of the
   * devices, or likely so (its MAC unreadable this time, at the address it was checked at).
   */
  statusConnected() {
    return (
      this.verdict === 'same' ||
      (this.verdict === 'unverified' && this.memory.owner?.at === this.config.key)
    );
  }

  /** The counts and the warnings of the last round. */
  statusMessage() {
    if (
      ['different', 'unbound', 'presumed'].includes(this.verdict) ||
      (this.verdict === 'unverified' && !this.statusConnected())
    ) {
      return join(
        this.verdictMessage(),
        this.saveFailed && !this.ownerUnknown ? T.storeProblem : undefined,
      );
    }
    const counts = { relays: 0, inputs: 0, zones: 0, thl: 0 };
    for (const target of this.model.values()) {
      if (target.kind === KINDS.RELAY) counts.relays += 1;
      else if (target.kind === KINDS.INPUT) counts.inputs += 1;
      else if (target.kind === KINDS.PILOT) counts.zones += 1;
      else counts.thl += 1;
    }
    const parts = [
      T.connected(this.config.version, counts),
      this.verdict === 'unverified' ? T.identityUnreadable : undefined,
      ...this.relayHints(),
    ];
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
    if (this.droppedPending.size > 0) {
      parts.push(T.pendingDropped(listOf([...this.droppedPending].map(shownCode))));
    }
    const multi = [...this.model.values()].filter((t) => t.value === MULTI);
    if (multi.length > 0) {
      parts.push(T.multiModes(listOf(multi.map((t) => shownCode(t.code)))));
    }
    const faults = [...this.model.values()].filter((t) => t.fault === true);
    if (faults.length > 0) {
      parts.push(T.thlFault(listOf(faults.map((t) => shownCode(t.code)))));
    }
    if (this.saveFailed || this.storeUnreadable) parts.push(T.storeProblem);
    return join(...parts);
  }

  /**
   * What the user must do for the relays to be driven: none listed (all read
   * only, the default), or a relay listed whose device, created in Gladys
   * before, still lacks the feature of its kind (Gladys adds it only on
   * "Update" in Discovery). Both read from what the SDK knows (the
   * configuration and `gladys.devices`), nothing guessed.
   */
  relayHints() {
    const relays = [...this.model.values()].filter((t) => t.kind === KINDS.RELAY);
    const listed = relays.filter((t) => this.config.relays.has(t.code));
    const hints = [];
    if (relays.length > 0 && listed.length === 0) {
      hints.push(T.relaysReadOnly(relays.length));
    }
    const created = new Map(this.createdDevices().map((d) => [d.external_id, d]));
    const waiting = listed.filter((t) => {
      const ids = idsOf(this.gladys, t.kind, t.code);
      const device = created.get(ids.device);
      const feature = ids.feature(this.config.relays.get(t.code));
      return (
        device !== undefined && !(device.features ?? []).some((f) => f?.external_id === feature)
      );
    });
    if (waiting.length > 0) {
      hints.push(T.relaysToUpdate(listOf(waiting.map((t) => shownCode(t.code)))));
    }
    return hints;
  }

  async refreshStatus() {
    await this.statusAgain();
    await this.flush();
  }

  // --- What a read changes -----------------------------------------------------------

  /**
   * After a read that left at `at` (a round or a read back): the states, the
   * commands checked against it, the guards checked against it (only reads
   * that left after the guard's last send count).
   */
  applyRead(at, { resend = true } = {}) {
    // Another IPX800 (or one not known for sure): none of its values reach these devices.
    if (!this.statusConnected()) return;
    const created = this.createdFeatures();
    for (const target of this.model.values()) {
      if (target.at !== at) continue;
      this.queueStates(target, created);
      const pending = this.pendingWrites.get(target.code);
      if (pending && at > pending.at && target.value !== undefined && target.value !== MULTI) {
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
        this.checkGuard(guard, target.value, resend, at);
      }
    }
  }

  /**
   * A guard (new, or from /data: `seq` 0, never sent by this process). `stale`: a command of
   * ours on its target still unanswered (one this guard cut, say): if the IPX handles it
   * late, the reads showing it are no change on the IPX.
   */
  makeGuard(
    {
      code,
      kind,
      value,
      resends = 0,
      confirmed = false,
      other,
      seq = 0,
      inFlight = false,
      userInFlight = false,
    },
    mono,
  ) {
    return {
      code,
      kind,
      value,
      resends,
      confirmed,
      other,
      seq,
      sentAt: -Infinity,
      inFlight,
      userInFlight,
      stale: this.mayLand(code, value, mono),
    };
  }

  /**
   * The last write of ours on `code` if it has another value than `value` and left less than
   * a request time ago: until it is answered, it may still land after a guard of `value`.
   */
  mayLand(code, value, mono = this.monotonic()) {
    const write = this.lastWrites.get(code);
    if (!write || write.value === value) return undefined;
    return mono - write.sentAt < TIMINGS.requestTimeout ? write : undefined;
  }

  /** A guard against a value read (by a read that left at `at`) after its last send. */
  checkGuard(guard, value, resend, at) {
    if (guard.kind === KINDS.RELAY && !this.config.relays.has(guard.code)) {
      this.guards.delete(guard.code);
      return;
    }
    if (value === undefined) {
      // Unknown is never "changed elsewhere".
      return;
    }
    if (value === MULTI) {
      // Several modes on (V5): not the one held, never "changed elsewhere"; sent again if not yet seen.
      if (!guard.confirmed && resend && guard.resends < TIMINGS.resendMax) {
        this.resendGuard(guard);
      }
      return;
    }
    // Answered since: the IPX handled it before answering, it cannot land any more.
    const stale = guard.stale?.answered ? undefined : guard.stale;
    if (value === guard.value) {
      guard.confirmed = true;
      guard.other = undefined;
      // Read after the time our older write could still land: out of the way for good.
      if (!stale || at > stale.sentAt + TIMINGS.requestTimeout) guard.stale = undefined;
      return;
    }
    if (stale && value === stale.value) {
      // Our own older write (cut by this command, or left without an answer) handled late by
      // the IPX: the guard is contradicted, never "changed on the IPX"; as a guard not seen
      // applied, it is sent again below.
      guard.stale = undefined;
      guard.confirmed = false;
      guard.other = undefined;
      this.logger.warn(
        `ipx800: ${shownCode(guard.code)} shows an older command of the integration, not a change on the IPX: still held`,
      );
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

  /**
   * Sends a guard again (no ack): protective priority, counted when it leaves. Cut by a
   * click before its first byte, it goes again right behind that click (within `deadline`),
   * not at the next read.
   */
  resendGuard(
    guard,
    priority = PRIORITY.GUARD,
    deadline = this.monotonic() + TIMINGS.requestTimeout,
  ) {
    const client = this.client;
    const target = this.targetOf(guard.code);
    if (guard.kind === KINDS.RELAY && !this.config.relays.has(guard.code)) {
      // No longer listed: never driven again.
      this.guards.delete(guard.code);
      this.saveMemory().catch(() => {});
      return;
    }
    if (!client || !target || guard.inFlight || !this.mayDrive(true)) return;
    guard.inFlight = true;
    let again = false;
    this.write(client, target, guard.value, priority, {
      deadline,
      beforeSend: () => {
        // A newer command that left meanwhile (or another protective one): never sent over it.
        if (
          this.guards.get(guard.code) !== guard ||
          (guard.kind === KINDS.RELAY && !this.config.relays.has(guard.code))
        ) {
          throw new IpxError('late', 'superseded');
        }
        // Another IPX800 found meanwhile: an Off kept for the old one never reaches it.
        if (!this.mayDrive(true)) throw new IpxError('late', 'not the IPX800 of the devices');
      },
      onSent: () => {
        // Counted once it has left (a try that never left is not a resend).
        guard.resends += 1;
        guard.sentAt = this.monotonic();
      },
    })
      .catch((err) => {
        again = err instanceof IpxError && err.code === 'cut' && !err.sent;
        this.logger.warn(`ipx800: ${shownCode(guard.code)} sent again: ${errorReason(err)}`);
      })
      .finally(() => {
        guard.inFlight = false;
        if (again && this.client === client && this.guards.get(guard.code) === guard) {
          // Nothing left: behind the click that cut it (the same checks before its first byte).
          this.resendGuard(guard, priority, deadline);
          return;
        }
        this.saveMemory().catch(() => {});
      });
    this.logger.info(`ipx800: ${shownCode(guard.code)} sent again`);
  }

  // --- Identity: the IPX800 of the devices ----------------------------------------
  //
  // The external ids hold no trace of the IPX800 (the first slot keeps the ids of 0.1.2):
  // which one a slot's devices belong to is the owner in /data, set at the first round of a
  // slot without devices (a V5 by the salted hash of its MAC address, read every round from
  // `system/info`; a V4, which gives none, by its controller key: model, address, port).
  // Another IPX800 at the address typed (or the model, or the address changed) gets no
  // command, no value published onto these devices, no Off kept for the old one, and an
  // empty Discover list, until the configuration points at the right one again or the user
  // attaches the devices to it ("Attach the devices", two clicks). A slot whose devices are
  // all deleted takes the IPX800 read as its owner. A file of 0.1.2 names the controller it
  // read last: taken as the owner once a round confirms it, unless the devices created hold
  // codes the model configured cannot have (an X-4FP of a V5 with a V4 typed).

  /** What a round read: a V5 by its MAC address (undefined: unreadable), a V4 by its address. */
  seenOf(mac) {
    if (this.config.version === 'v4') return { kind: 'address', id: this.config.key };
    return mac
      ? { kind: 'mac', id: macId(this.memory.salt, mac), label: mac.slice(-8) }
      : undefined;
  }

  /** No device of this slot holds a code the model configured cannot have. */
  devicesFitModel() {
    const impossible = this.config.version === 'v4' ? V5_ONLY : V4_ONLY;
    return !this.createdDevices().some((d) => impossible(this.parseId(d.external_id).code));
  }

  /** /data cannot be read, or cannot be written while it holds nothing: owner unknown. */
  get ownerUnknown() {
    return this.storeUnreadable || this.storeLost;
  }

  /** Before any read: from /data and the configuration only. */
  verdictAtStart() {
    const owner = this.memory.owner;
    if (this.ownerUnknown || !owner) return 'unbound';
    // 0.1.2 kept the controller it read last, not the one the devices were made for.
    if (owner.legacy) return this.devicesFitModel() ? 'presumed' : 'unbound';
    if (owner.kind === 'mac') return this.config.version === 'v5' ? 'pending' : 'different';
    return owner.id === this.config.key ? 'same' : 'different';
  }

  /** After a round that read `seen`: the verdict; a slot without devices takes it as owner. */
  judge(seen) {
    const owner = this.memory.owner;
    const key = this.config.key;
    // /data unreadable is not empty: no owner is set over it (protective commands only).
    if (this.ownerUnknown) return 'unbound';
    const hasDevices = this.createdDevices().length > 0;
    const bind = (why) => {
      this.memory.owner =
        seen?.kind === 'mac'
          ? { kind: 'mac', id: seen.id, at: key }
          : { kind: 'address', id: key, at: key };
      if (owner) this.dropGuards('owner changed');
      this.logger.info(
        `ipx800: devices of IPX800 #${this.slot} now belong to the IPX800 read (${why})`,
      );
      return 'same';
    };
    if (!owner) return hasDevices ? 'unbound' : bind('first read');
    if (owner.legacy) {
      // A presumption only (the last controller 0.1.2 read): confirmed by "Attach the devices".
      if (!hasDevices) return bind('no device left');
      return this.devicesFitModel() ? 'presumed' : 'unbound';
    }
    let verdict;
    if (owner.kind === 'mac') {
      if (seen?.kind === 'mac') verdict = seen.id === owner.id ? 'same' : 'different';
      else verdict = this.config.version === 'v4' ? 'different' : 'unverified';
    } else {
      verdict = owner.id === key ? 'same' : 'different';
    }
    if (verdict === 'different' && !hasDevices) return bind('no device left');
    if (verdict === 'same') {
      // A V5 known by its address so far is known by its MAC from now on (never the reverse).
      this.memory.owner =
        seen?.kind === 'mac'
          ? { kind: 'mac', id: seen.id, at: key }
          : { kind: owner.kind, id: owner.id, at: key };
    }
    return verdict;
  }

  applyVerdict(verdict) {
    if (verdict === 'different' && this.verdict !== 'different') {
      this.logger.warn(
        `ipx800: IPX800 #${this.slot}: another IPX800 answers at this address; its devices get nothing`,
      );
    }
    this.verdict = verdict;
    if (verdict === 'different') this.dropGuards('another IPX800');
  }

  /** The Offs kept for the owner never go to another IPX800. */
  dropGuards(why) {
    if (this.guards.size > 0) {
      this.logger.warn(`ipx800: ${this.guards.size} Off kept dropped (${why})`);
    }
    this.guards.clear();
    this.pendingWrites.clear();
    this.warnings.clear();
  }

  /**
   * A V5 owner whose MAC must be read again before an Off leaves (at start, and after a
   * failed round: it may have been replaced meanwhile at the same address).
   */
  recheck() {
    if (
      this.verdict === 'same' &&
      this.config.version === 'v5' &&
      this.memory.owner?.kind === 'mac'
    ) {
      this.verdict = 'pending';
      this.identityCheck = undefined;
    }
  }

  /** Its MAC read once (bounded): before the Offs kept leave at start, or a click after a failure. */
  async checkIdentity(client, generation) {
    let mac;
    try {
      mac = parseMac(
        await client.v5Info(PRIORITY.GUARD, {
          deadline: this.monotonic() + TIMINGS.requestTimeout,
        }),
      );
    } catch {
      mac = undefined;
    }
    if (generation !== this.generation || this.verdict !== 'pending') return;
    const owner = this.memory.owner;
    const seen = this.seenOf(mac);
    if (!owner || owner.kind !== 'mac') return;
    this.applyVerdict(seen ? (seen.id === owner.id ? 'same' : 'different') : 'unverified');
    if (this.verdict === 'different') {
      this.seen = seen;
      await this.saveMemory();
      if (generation === this.generation) await this.setStatus(false, this.statusMessage());
    }
  }

  /**
   * May a command leave for this IPX800? `protective`: an Off / Frost protection, sent unless
   * the IPX800 is proven another one, or not known for sure; while its MAC is being read or
   * cannot be read, only at the address it was last checked at. The others: only to the
   * IPX800 of the devices, checked by the last round.
   */
  mayDrive(protective) {
    switch (this.verdict) {
      case 'same':
        return true;
      case 'pending':
      case 'unverified':
      case 'presumed':
        // The address last checked (for 'presumed', the one 0.1.2 read last, as 0.1.2 did).
        return protective && this.memory.owner?.at === this.config.key;
      case 'unbound':
        // /data unreadable or never written: owner unknown, the Offs go to the address typed.
        return protective && this.ownerUnknown;
      default:
        return false;
    }
  }

  /** A command arriving while the MAC is read at start waits for it (bounded), then the verdict. */
  async identityGate(protective, received) {
    if (this.verdict === 'pending' && !this.identityCheck && this.client) {
      this.identityCheck = this.checkIdentity(this.client, this.generation);
    }
    if (this.verdict === 'pending' && this.identityCheck) {
      const until = received + (protective ? TIMINGS.identityWait : TIMINGS.commandSendBy);
      let timer;
      await Promise.race([
        this.identityCheck.catch(() => {}),
        new Promise((resolve) => {
          timer = this.timers.setTimeout(resolve, Math.max(0, until - this.monotonic()));
        }),
      ]);
      this.timers.clearTimeout(timer);
    }
    if (!this.mayDrive(protective)) throw this.refusal(this.verdictError());
  }

  verdictError() {
    if (this.wrongModel) return ERRORS.wrongModel(this.config.version, this.wrongModel);
    switch (this.verdict) {
      case 'different':
        return ERRORS.otherIpx(this.slot);
      case 'pending':
      case 'unverified':
        return this.memory.owner?.at === this.config.key
          ? ERRORS.identityUnread
          : ERRORS.newAddress(this.slot);
      case 'presumed':
        return ERRORS.toConfirm(this.slot);
      default:
        if (this.ownerUnknown) return ERRORS.ownerUnknown;
        return this.memory.owner?.legacy
          ? ERRORS.toConfirm(this.slot)
          : ERRORS.notAttached(this.slot);
    }
  }

  /** The IPX800 of this slot as the user knows it: "V5 (MAC …34:56)" or "V4 at 192.168.1.60". */
  shownIpx() {
    const v = this.config.version === 'v4' ? 'V4' : 'V5';
    const address =
      this.config.port === 80 ? this.config.host : `${this.config.host}:${this.config.port}`;
    return this.seen?.label
      ? both(`${v} (MAC …${this.seen.label})`, `${v} (MAC …${this.seen.label})`)
      : both(`${v} at ${address}`, `${v} à ${address}`);
  }

  verdictMessage() {
    if (this.verdict === 'different') {
      return T.otherIpx(this.slot, this.config.version, this.seen?.label);
    }
    if (this.verdict === 'unverified') return T.identityUnreadableNew;
    if (this.verdict === 'presumed') {
      return T.legacyConfirm(
        this.slot,
        this.shownIpx(),
        this.createdDevices().length,
        this.memory.owner?.at === this.config.key,
      );
    }
    if (this.storeUnreadable) return T.ownerUnreadable;
    if (this.storeLost) return T.ownerUnwritable;
    return this.memory.owner?.legacy ? T.legacyNotAttached(this.slot) : T.notAttached(this.slot);
  }

  /**
   * "Attach the devices": the devices of this slot belong from now on to the IPX800 read by
   * the last round (another one, or one not known for sure). Two clicks within a minute on
   * the same IPX800: the relays listed then drive that one. Its kept Offs are dropped.
   */
  async attach() {
    if (!this.client || !this.round || this.offline || this.wrongModel) {
      return T.attach.notRead;
    }
    if (this.verdict === 'same') return T.attach.already(this.slot);
    // Kept nowhere (until the next restart only): refused, said.
    if (this.ownerUnknown || this.saveFailed) return T.storeProblem;
    if (this.verdict === 'pending') return T.attach.unreadable;
    const mono = this.monotonic();
    const id = this.seen?.id ?? this.config.key;
    const count = this.createdDevices().length;
    const ask = this.attachAsk;
    if (!ask || ask.id !== id || mono - ask.at > TIMINGS.attachConfirm) {
      this.attachAsk = { at: mono, id };
      // A V5 whose MAC cannot be read (any more): attached by its address, as a V4.
      return this.seen?.kind === 'mac'
        ? T.attach.confirm(this.slot, this.config.version, this.seen.label, count)
        : T.attach.confirmAddress(this.slot, this.shownIpx(), count, this.config.version === 'v5');
    }
    this.attachAsk = undefined;
    const seen = this.seen;
    const key = this.config.key;
    this.memory.owner =
      seen?.kind === 'mac'
        ? { kind: 'mac', id: seen.id, at: key }
        : { kind: 'address', id: key, at: key };
    this.dropGuards('devices attached to another IPX800');
    this.verdict = 'same';
    this.logger.info(`ipx800: devices of IPX800 #${this.slot} attached to the IPX800 read`);
    await this.saveMemory();
    this.published = undefined;
    await this.setStatus(this.statusConnected(), this.statusMessage());
    await this.publishDevices();
    return T.attach.done(this.slot, count);
  }

  // --- Gladys --------------------------------------------------------------------

  /** One of the external ids of this slot: `{ kind, code, key }`; undefined otherwise. */
  parseId(externalId) {
    return parseExternalId(externalId, this.gladys.selector, this.slot);
  }

  createdDevices() {
    return (this.gladys.devices ?? []).filter((d) => this.parseId(d.external_id));
  }

  createdFeatures() {
    return new Map(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => [f.external_id, f])),
    );
  }

  /**
   * The Discover list: the targets of the IPX800 really read (a round of this session, no
   * failure since, the IPX800 of the devices), the features of the devices created kept.
   * Anything else (not read yet, unreachable, refused key, another IPX800 or model) is an
   * empty list: nothing of a box not read stays there.
   */
  async publishDevices() {
    const devices = [];
    if (this.round && !this.offline && this.verdict === 'same' && !this.refusedApplies()) {
      const created = new Map();
      for (const device of this.createdDevices()) created.set(device.external_id, device);
      for (const target of this.model.values()) {
        if (target.at === undefined) continue;
        const ids = idsOf(this.gladys, target.kind, target.code);
        devices.push(
          buildDevice(this.gladys, target, {
            language: this.config.language,
            relayKind: this.config.relays.get(target.code),
            created: created.get(ids.device),
            slot: this.slot,
          }),
        );
      }
    }
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
    const parsed = this.parseId(device?.external_id);
    const target = parsed && this.model.get(parsed.code);
    const mono = this.monotonic();
    if (
      target &&
      target.at !== undefined &&
      !this.offline &&
      this.statusConnected() &&
      this.pauseLeft(mono) === 0 &&
      mono - target.at <= this.interval + TIMINGS.roundBudget
    ) {
      const created = this.createdFeatures();
      for (const f of device?.features ?? []) created.set(f.external_id, f);
      this.queueStates(target, created);
      await this.flush();
    }
    // A relay created or updated in Discovery may end a "waiting for Update" in the status.
    if (parsed?.kind === KINDS.RELAY) await this.statusAgain();
  }

  async deviceDeleted(device) {
    if (device?.external_id) this.publisher.forget(device.external_id);
    const parsed = this.parseId(device?.external_id);
    if (!parsed) return;
    // The list again at once: a device recreated right away gets the features of now (a
    // relay removed from the list no longer gets back the switch of the deleted device).
    await this.publishDevices();
    if (parsed.kind === KINDS.RELAY) await this.statusAgain();
  }

  /** The status of the last round again (what Gladys knows changed), never during a failure. */
  async statusAgain() {
    if (this.round && !this.offline && !this.refusedApplies()) {
      await this.setStatus(this.statusConnected(), this.statusMessage());
    }
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

  /**
   * One write through the lane; resolves when the IPX accepted it. What left is kept per
   * target (`lastWrites`): until it is answered, it may land after a newer guard.
   */
  write(client, target, value, priority, hooks) {
    const record = { value, sentAt: undefined, answered: false };
    const tracked = {
      ...hooks,
      onSent: () => {
        record.sentAt = this.monotonic();
        this.lastWrites.set(target.code, record);
        hooks.onSent?.();
      },
    };
    let written;
    if (this.config.version === 'v4') {
      const query = v4WriteQuery(target, value, V4_FP_CODE.get(value));
      if (!query) return Promise.reject(new IpxError('bad_request', 'invalid write'));
      written = client.v4Write(query, priority, tracked);
    } else {
      const io = v5Write(target, value);
      if (!io) return Promise.reject(new IpxError('bad_request', 'invalid write'));
      written = client.v5Write(io.id, io.on, priority, tracked);
    }
    written.then(
      () => {
        record.answered = true;
      },
      (err) => {
        // An answer came (a refusal, a status): handled before it, it cannot land later.
        record.answered = !(
          err instanceof IpxError && ['cut', 'timeout', 'network'].includes(err.code)
        );
      },
    );
    return written;
  }

  /**
   * A read of the IPX that leaves after this call (shared by the commands
   * asking for one before it leaves): `{ values: Map(code -> value), at }`.
   */
  readBack(priority, deadline, { resend = false, after = Infinity } = {}) {
    const job = this.readBackJob;
    // Shared when it leaves after the caller's write: not left yet (the write is answered), or
    // left after the write left (one request at a time: then after its answer too).
    if (
      job &&
      job.priority <= priority &&
      job.client === this.client &&
      (!job.started || job.sentAt > after)
    ) {
      return job.promise;
    }
    const client = this.client;
    const generation = this.generation;
    const next = { started: false, priority, client, sentAt: undefined };
    next.promise = (async () => {
      let at;
      const hooks = {
        deadline,
        onSent: () => {
          next.started = true;
          at = this.monotonic();
          next.sentAt = at;
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
    const parsed = this.parseId(feature?.external_id);
    if (!parsed || ![F.SWITCH, F.LIGHT, F.MODE].includes(parsed.key)) {
      throw this.refusal(parsed?.key === F.READONLY ? ERRORS.readOnly : ERRORS.notCommandable);
    }
    const wanted = integerOf(value);
    const kind = parsed.kind;
    if (!this.ready) {
      // The configuration not read yet (or being applied): ask for it now and wait a little.
      const protective =
        isProtective(kind, wanted) && (kind !== KINDS.PILOT || V4_FP_CODE.has(wanted));
      // Kept in memory only (the key never goes to /data): while this click waits, it is its
      // own; past the wait, it is sent by the start that reads the configuration.
      const pending = protective ? { kind, value: wanted, waiting: true } : undefined;
      if (pending) this.pendingProtectives.set(parsed.code, pending);
      if (!this.configLoaded) this.askConfig();
      const ready = await this.waitReady(received + TIMINGS.configWait);
      if (this.pendingProtectives.get(parsed.code) === pending) {
        if (ready) this.pendingProtectives.delete(parsed.code);
        // Not ready means no client yet: the start that makes it sends it (ready is set in
        // the same turn as that adoption, so no click can fall between the two).
        else if (pending) pending.waiting = false;
      }
      if (!ready) {
        if (pending) throw this.refusal(ERRORS.keptUntilConfig);
        throw this.refusal(ERRORS.configNotLoaded);
      }
    }
    if (!this.client) throw this.refusal(ERRORS.noConfig);
    if (kind === KINDS.RELAY) {
      if (wanted !== 0 && wanted !== 1) throw this.refusal(ERRORS.badValue);
      if (!this.config.relays.has(parsed.code)) throw this.refusal(ERRORS.readOnly);
    } else if (kind === KINDS.PILOT) {
      if (wanted === undefined || !V4_FP_CODE.has(wanted)) throw this.refusal(ERRORS.badValue);
    } else {
      throw this.refusal(ERRORS.notCommandable);
    }
    // Never to another IPX800 than the one these devices were made for, an Off neither.
    await this.identityGate(isProtective(kind, wanted), received);
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
    if (!this.mayDrive(false)) throw this.refusal(this.verdictError());
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
      // Put back only where no newer guard took its place (an Off clicked meanwhile wins).
      if (guard && !this.guards.has(job.code)) this.guards.set(job.code, guard);
      if (!saved) {
        throw this.refusal(ERRORS.saveFailed);
      }
      if (generation !== this.generation) throw this.refusal(ERRORS.unknownTarget);
    }
    let left = false;
    let writtenAt;
    const restoreGuard = () => {
      if (guard && !this.guards.has(job.code)) this.guards.set(job.code, guard);
    };
    try {
      await this.write(client, target, job.wanted, PRIORITY.COMMAND, {
        deadline: job.received + TIMINGS.commandAnswerBy,
        beforeSend: () => this.checkBeforeSend(job, generation, client),
        onSent: () => {
          left = true;
          writtenAt = this.monotonic();
          // A newer command that left: the guard of this target ends here.
          if (this.guards.get(job.code) === guard) this.guards.delete(job.code);
          this.pendingWrites.set(job.code, {
            expected: job.wanted,
            at: this.monotonic(),
          });
        },
      });
    } catch (err) {
      if (
        left &&
        err instanceof IpxError &&
        ['refused', 'busy', 'http', 'not_success'].includes(err.code)
      ) {
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
    const confirmation = this.confirm(job.code, job.kind, job.wanted, job.received, {
      after: writtenAt,
    });
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
  async confirm(code, kind, wanted, received, { protective = false, after }) {
    const waitWrites = !protective;
    let read;
    if (waitWrites && this.serving) {
      // The commands waiting are written first (a scene): one read back then serves them all;
      // never past the time to send, so that the ack stays within the 5 s of Gladys.
      let timer;
      await Promise.race([
        this.serving.catch(() => {}),
        new Promise((resolve) => {
          timer = this.timers.setTimeout(
            resolve,
            Math.max(0, received + TIMINGS.commandSendBy - this.monotonic()),
          );
        }),
      ]);
      this.timers.clearTimeout(timer);
    }
    try {
      // A protective read back goes before the other commands, but any later Off clicked cuts it.
      read = await this.readBack(
        protective ? PRIORITY.GUARD : PRIORITY.CONFIRM,
        received + TIMINGS.commandAnswerBy,
        { after },
      );
    } catch {
      throw this.refusal(ERRORS.unconfirmed);
    }
    await this.refreshStatus();
    const value = read.values.get(code);
    if (value === wanted) return undefined;
    if (value === undefined || value === MULTI) throw this.refusal(ERRORS.unconfirmed);
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
    const guard = this.makeGuard({
      code,
      kind: target.kind,
      value: wanted,
      seq: this.seq,
      inFlight: true,
      userInFlight: true,
    });
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
            // Right before the first byte, at every try: a newer click on this target (say
            // during the wait between two tries) took its place; nothing leaves after it.
            if (this.guards.get(code) !== guard) throw new IpxError('late', 'superseded');
            if (!this.mayDrive(true)) throw new IpxError('late', 'not the IPX800 of the devices');
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
          this.guards.get(code) !== guard ||
          !this.mayDrive(true) ||
          mono - first >= TIMINGS.protectiveRetry ||
          mono >= sendBy
        ) {
          break;
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.protectiveRetryGap));
        // A newer click during the wait: no new try at all, so that it cuts nothing (the read
        // back of that click, say). One already queued is stopped by `beforeSend` above.
        if (generation !== this.generation || this.guards.get(code) !== guard) {
          break;
        }
      }
    }
    guard.inFlight = false;
    guard.userInFlight = false;
    if (!left && !this.mayDrive(true)) {
      // Another IPX800 found meanwhile: not kept, never sent to it.
      if (this.guards.get(code) === guard) this.guards.delete(code);
      this.saveMemory().catch(() => {});
      throw this.refusal(this.verdictError());
    }
    this.saveMemory().catch(() => {});
    if (!left) {
      if (this.guards.get(code) !== guard) {
        // A later command on this target took its place.
        throw this.refusal(ERRORS.cancelledByStop);
      }
      // Kept: sent again as soon as the lane is free, and by the reads that show another value.
      // Still the click: ahead of the read backs.
      if (generation === this.generation) this.resendGuard(guard, PRIORITY.PROTECTIVE);
      this.refreshStatus().catch(() => {});
      throw this.refusal(ERRORS.protectiveKept(reasonOf(lastError)));
    }
    this.afterWrite(generation);
    if (lastError) {
      throw this.commandError(lastError, true, 0);
    }
    // Its read back is cut by any later Off clicked; it never waits for the other commands.
    return this.confirm(code, target.kind, wanted, received, {
      protective: true,
      after: guard.sentAt,
    });
  }
}
