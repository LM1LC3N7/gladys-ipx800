// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app (the IpxHub of src/hub.js in the
// container, or one IpxApp). Shared by index.js and the end-to-end tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the relays, inputs, pilot-wire zones and X-THL of the IPX800.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands: the declared relays and the pilot-wire zones.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());
  gladys.onAction(ACTIONS.ATTACH, (fields) => app.attach(fields));

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Every connection to Gladys: the configuration is read (again on failure,
  // with a status), then the first connection starts, a reconnection resends.
  gladys.on('connected', async () => {
    try {
      await app.onConnected(() => gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
