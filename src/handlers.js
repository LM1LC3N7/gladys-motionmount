// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the mount is published at each connection; Scan sends it again.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys): a
  // reconnection keeps the blocks and the connection to the mount, and
  // publishes the status, the Discovery and the badges again. A configuration
  // that cannot be read is asked again 30 s later (never an integration left
  // without its configuration until the next reconnection).
  let retry;
  const start = async () => {
    app.timers.clearTimeout(retry);
    retry = undefined;
    try {
      await app.connected(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
      retry = app.timers.setTimeout(() => {
        start();
      }, RETRY_START);
    }
  };
  gladys.on('connected', start);
}

/** The wait before the configuration is asked again after a failed start. */
export const RETRY_START = 30_000;
