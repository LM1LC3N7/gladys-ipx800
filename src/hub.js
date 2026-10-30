// -----------------------------------------------------------------------------
// Several IPX800 in one integration (Gladys runs one instance of it): up to
// SLOTS controllers, each an IpxApp of its own (its lane of requests, its
// /data file, its owner, its guards: src/app.js unchanged per controller),
// behind ONE view of Gladys each:
//   - its external ids (`ext:<selector>:ipx<n>:...` for n >= 2, those of
//     0.1.2 for the first) and its created devices only;
//   - the connection status: the first slot's own while it is the only one
//     used, one part per IPX800 otherwise, separated by " | " (Gladys shows
//     one block), connected when all of them are;
//   - the Discover list: the lists of the slots put together;
//   - the states: one publisher, so that the 300 states a minute of Gladys
//     hold for all of them.
// A slot is used when an address or a key is typed for it, or when it has
// devices (they then get a status saying what is missing). Two slots typed
// with the same address: the one whose devices' IPX800 was verified there
// keeps it, the other is not read (see slotConfigs in src/config.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { IpxApp } from './app.js';
import { SLOTS, normalizeConfig, sharedAddresses, slotConfigs, slotTyped } from './config.js';
import { slotOf, slotPrefix } from './devices.js';
import { ERRORS, T, both, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, stateFile } from './store.js';

export class IpxHub {
  constructor({
    gladys,
    logger = createLogger({ name: 'ipx800' }),
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    storeOf = (slot) => fileStore(stateFile(slot)),
    random,
    slots = SLOTS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.raw = {};
    /** slot -> { connected, message } as the controller set it. */
    this.statuses = new Map();
    /** slot -> the Discover list of the controller. */
    this.lists = new Map();
    this.lastStatus = undefined;
    this.published = undefined;
    this.loading = undefined;
    /** The configurations saved, handed on one after the other (see configUpdated). */
    this.updates = Promise.resolve();
    this.controllers = new Map();
    for (let slot = 1; slot <= slots; slot += 1) {
      this.controllers.set(
        slot,
        new IpxApp({
          gladys: this.view(slot),
          logger,
          transport,
          now,
          monotonic,
          timers,
          store: storeOf(slot),
          ...(random ? { random } : {}),
          slot,
          publisher: this.publisher,
        }),
      );
    }
  }

  /** What a controller sees of Gladys: its ids, its devices, its status, its Discover list. */
  view(slot) {
    const gladys = this.gladys;
    const hub = this;
    return {
      get selector() {
        return gladys.selector;
      },
      get devices() {
        return (gladys.devices ?? []).filter(
          (d) => slotOf(d.external_id, gladys.selector) === slot,
        );
      },
      externalIds: (kind, code) => gladys.externalIds(`${slotPrefix(slot)}${kind}`, code),
      publishChangedStates: (...args) => gladys.publishChangedStates(...args),
      forgetPublishedStates: () => gladys.forgetPublishedStates?.(),
      setConnectionStatus: (connected, message) => hub.slotStatus(slot, connected, message),
      publishDiscoveredDevices: (devices) => hub.slotList(slot, devices),
    };
  }

  /** The controller of an external id (the first slot for an id without `ipx<n>:`). */
  controllerOf(externalId) {
    return this.controllers.get(slotOf(externalId, this.gladys.selector));
  }

  /** Used: an address or a key typed, or devices created for it. */
  used(slot) {
    if (slotTyped(this.raw, slot)) return true;
    const selector = this.gladys.selector;
    return (this.gladys.devices ?? []).some((d) => slotOf(d.external_id, selector) === slot);
  }

  get usedSlots() {
    return [...this.controllers.keys()].filter((slot) => this.used(slot));
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * One read of the configuration for all the controllers (asked together, read once): the
   * configuration of each slot (`slotConfigs`).
   */
  load(read) {
    this.loading ??= Promise.resolve()
      .then(read)
      .then(async (raw) => {
        this.remember(raw);
        return this.configsOf(raw);
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  /**
   * The configuration of each slot; for slots typed with the same address, the controller key
   * at which the IPX800 of each one's devices was last verified (from /data, bounded) decides
   * which one keeps it.
   */
  async configsOf(raw) {
    const verified = new Map();
    const shared = sharedAddresses(raw, this.controllers.size).flat();
    await Promise.all(
      shared.map(async (slot) => {
        verified.set(slot, await this.controllers.get(slot).verifiedAt());
      }),
    );
    return slotConfigs(raw, this.controllers.size, verified);
  }

  remember(raw) {
    this.raw = raw ?? {};
  }

  async onConnected(read) {
    this.publisher.start();
    await Promise.all(
      [...this.controllers].map(([slot, app]) =>
        app.onConnected(async () => (await this.load(read)).get(slot)),
      ),
    );
    // Gladys restarted: what it keeps in memory only, again.
    this.lastStatus = undefined;
    this.published = undefined;
    await this.pushStatus();
    await this.pushList().catch((err) =>
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`),
    );
  }

  /**
   * A configuration saved: handed to the controllers in the order saved (the slots' /data may
   * be read in between, for slots typed with the same address), each applying the last one.
   */
  async configUpdated(raw = {}) {
    const run = this.updates.then(async () => {
      this.remember(raw);
      const configs = await this.configsOf(raw);
      return [...this.controllers].map(([slot, app]) => app.configUpdated(configs.get(slot)));
    });
    this.updates = run.catch(() => {});
    await Promise.all(await run);
    await this.pushStatus();
  }

  async shutdown() {
    await Promise.all([...this.controllers.values()].map((app) => app.shutdown()));
    this.publisher.stop();
  }

  stop() {
    for (const app of this.controllers.values()) app.stop();
    this.publisher.stop();
  }

  // --- What Gladys shows -------------------------------------------------------

  async slotStatus(slot, connected, message) {
    this.statuses.set(slot, { connected, message });
    await this.pushStatus();
  }

  /** The status: the first slot's own when alone, else one part per IPX800 used (" | "). */
  async pushStatus() {
    const slots = this.usedSlots;
    let connected;
    let message;
    if (slots.length <= 1) {
      const status = this.statuses.get(slots[0] ?? 1);
      if (!status) return;
      ({ connected, message } = status);
    } else {
      const parts = slots.map((slot) => {
        const status = this.statuses.get(slot) ?? { connected: false, message: T.connecting };
        const text = status.message ?? both('', '');
        return both(
          `IPX800 #${slot}: ${text.en ?? ''}`.trim(),
          `IPX800 n°${slot} : ${text.fr ?? text.en ?? ''}`.trim(),
        );
      });
      connected = slots.every((slot) => this.statuses.get(slot)?.connected === true);
      message = joinLines(parts);
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async slotList(slot, devices) {
    this.lists.set(slot, devices);
    await this.pushList();
  }

  /** The Discover list of all the slots (an empty one too: what is not read any more goes). */
  async pushList() {
    const devices = [...this.controllers.keys()].flatMap((slot) => this.lists.get(slot) ?? []);
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    this.published = json;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.published = undefined;
      // Thrown to the controller, which then publishes again at its next change.
      throw err;
    }
  }

  // --- Handlers ------------------------------------------------------------------

  async scan() {
    await Promise.all([...this.controllers.values()].map((app) => app.scan()));
  }

  // An id of a slot this version does not have (`ipx7:`): not ours, a plain refusal.
  deviceCreated(device) {
    return this.controllerOf(device?.external_id)?.deviceCreated(device);
  }

  deviceDeleted(device) {
    return this.controllerOf(device?.external_id)?.deviceDeleted(device);
  }

  async setValue(device, feature, value) {
    const app = this.controllerOf(feature?.external_id);
    if (!app) {
      throw new Error(word(ERRORS.unknownTarget, normalizeConfig(this.raw).language));
    }
    return app.setValue(device, feature, value);
  }

  /** "Test the connection": each IPX800 used, at once (each has its own lane). */
  async testConnection() {
    const slots = this.usedSlots;
    if (slots.length <= 1) return this.controllers.get(slots[0] ?? 1).testConnection();
    const answers = await Promise.all(
      slots.map((slot) => this.controllers.get(slot).testConnection()),
    );
    return joinLines(
      answers.map((answer, i) =>
        both(
          `IPX800 #${slots[i]}: ${answer.en}`,
          `IPX800 n°${slots[i]} : ${answer.fr ?? answer.en}`,
        ),
      ),
    );
  }

  /** "Attach the devices" of the IPX800 chosen (the first one when not given). */
  attach(fields = {}) {
    const slot = Number(fields?.ipx ?? 1);
    const app = this.controllers.get(slot);
    if (!app) return T.attach.noSlot;
    return app.attach();
  }
}

/** Several messages, one after the other, separated by " | ". */
function joinLines(messages) {
  const parts = messages.filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? join();
  // Gladys shows the status as one block (no line breaks kept): a visible separator.
  return both(parts.map((m) => m.en).join(' | '), parts.map((m) => m.fr).join(' | '));
}
