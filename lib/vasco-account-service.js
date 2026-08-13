const {
  VascoAuthenticationError,
  VascoProtocolError,
  VascoTransportError,
} = require('./vasco-errors');
const {
  discoverVentilationDevices,
  toDeviceState,
} = require('./vasco-device-mapper');

const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 30 * 60_000;
const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: timer => clearTimeout(timer),
});
const AUTHENTICATION_MESSAGE = 'Vasco authentication failed; update the account credentials';

class VascoAccountService {
  constructor({ apiClient, email, password, clock = DEFAULT_CLOCK, notify = () => {} }) {
    if (!apiClient || typeof apiClient.login !== 'function') {
      throw new TypeError('apiClient must provide login');
    }
    if (!isNonEmptyString(email) || typeof password !== 'string' || password.length === 0) {
      throw new TypeError('Vasco account credentials are required');
    }
    if (!clock
      || typeof clock.now !== 'function'
      || typeof clock.setTimeout !== 'function'
      || typeof clock.clearTimeout !== 'function') {
      throw new TypeError('clock must provide now, setTimeout, and clearTimeout');
    }
    if (typeof notify !== 'function') {
      throw new TypeError('notify must be a function');
    }

    this.apiClient = apiClient;
    this.email = email;
    this.password = password;
    this.clock = clock;
    this.notify = notify;

    this.sessionToken = null;
    this.loginPromise = null;
    this.credentialVersion = 0;
    this.activeRead = null;
    this.queuedForcedRead = null;
    this.commandChains = new Map();
    this.polling = null;
    this.authenticationNotificationSent = false;
  }

  readConfiguration({ force = false } = {}) {
    if (!this.activeRead) {
      return this._startRead();
    }

    if (!force) {
      return this.activeRead.promise;
    }

    if (this.queuedForcedRead) {
      return this.queuedForcedRead.promise;
    }

    const predecessor = this.activeRead.promise;
    const queued = { promise: null };
    queued.promise = predecessor
      .catch(() => undefined)
      .then(() => {
        if (this.queuedForcedRead === queued) {
          this.queuedForcedRead = null;
        }
        return this._startRead();
      });
    this.queuedForcedRead = queued;
    return queued.promise;
  }

  executeDeviceCommand(identity, build, confirm) {
    if (!isNonEmptyString(identity)) {
      return Promise.reject(new TypeError('A device identity is required'));
    }
    if (typeof build !== 'function' || typeof confirm !== 'function') {
      return Promise.reject(new TypeError('Command build and confirmation functions are required'));
    }

    const predecessor = this.commandChains.get(identity) ?? Promise.resolve();
    const command = predecessor
      .catch(() => undefined)
      .then(() => this._executeDeviceCommand(identity, build, confirm));
    this.commandChains.set(identity, command);
    command.then(
      () => this._deleteCommandChain(identity, command),
      () => this._deleteCommandChain(identity, command),
    );
    return command;
  }

  startPolling(intervalSeconds, onState, onAvailability) {
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new RangeError('Polling interval must be a positive number of seconds');
    }
    if (typeof onState !== 'function' || typeof onAvailability !== 'function') {
      throw new TypeError('Polling callbacks must be functions');
    }

    this.stopPolling();
    const polling = {
      intervalMs: intervalSeconds * 1_000,
      onState,
      onAvailability,
      consecutiveFailures: 0,
      available: null,
      timer: null,
      stopped: false,
    };
    this.polling = polling;
    this._schedulePoll(polling, polling.intervalMs);
  }

  stopPolling() {
    const polling = this.polling;
    if (!polling) return;

    polling.stopped = true;
    if (polling.timer !== null) {
      this.clock.clearTimeout(polling.timer);
      polling.timer = null;
    }
    this.polling = null;
  }

  async updateCredentials(email, password) {
    if (!isNonEmptyString(email) || typeof password !== 'string' || password.length === 0) {
      throw new TypeError('Vasco account credentials are required');
    }

    let token;
    try {
      token = await this.apiClient.login(email, password);
    } catch (error) {
      throw redactApiError(error, 'Vasco credential validation failed');
    }

    this.email = email;
    this.password = password;
    this.credentialVersion += 1;
    this.sessionToken = token;
    this.authenticationNotificationSent = false;
  }

  _startRead() {
    const active = { promise: null };
    const read = this._withSession(token => this.apiClient.getAccountConfiguration(token));
    active.promise = read.finally(() => {
      if (this.activeRead === active) {
        this.activeRead = null;
      }
    });
    this.activeRead = active;
    return active.promise;
  }

  async _executeDeviceCommand(identity, build, confirm) {
    const before = await this.readConfiguration();
    const device = findDevice(before, identity);
    const command = build(device.raw);

    await this._withSession(token => this.apiClient.setDeviceProperties(token, [command]));

    const after = await this.readConfiguration({ force: true });
    const confirmedDevice = findDevice(after, identity);
    const state = toDeviceState(confirmedDevice.raw);
    if (!confirm(state)) {
      throw new VascoProtocolError('Vasco device state did not confirm the requested command');
    }
    return state;
  }

  _deleteCommandChain(identity, command) {
    if (this.commandChains.get(identity) === command) {
      this.commandChains.delete(identity);
    }
  }

  async _getSessionToken() {
    if (this.sessionToken !== null) {
      return this.sessionToken;
    }
    if (this.loginPromise) {
      return this.loginPromise;
    }

    const version = this.credentialVersion;
    const login = (async () => {
      let token;
      try {
        token = await this.apiClient.login(this.email, this.password);
      } catch (error) {
        throw redactApiError(error, 'Vasco login failed');
      }

      if (version === this.credentialVersion) {
        this.sessionToken = token;
        return token;
      }
      return this.sessionToken;
    })();
    this.loginPromise = login;

    try {
      return await login;
    } finally {
      if (this.loginPromise === login) {
        this.loginPromise = null;
      }
    }
  }

  async _withSession(operation) {
    let token;
    try {
      token = await this._getSessionToken();
    } catch (error) {
      if (error instanceof VascoAuthenticationError) {
        throw this._authenticationFailure();
      }
      throw error;
    }

    try {
      return await operation(token);
    } catch (error) {
      if (!(error instanceof VascoAuthenticationError)) {
        throw redactApiError(error, 'Vasco account operation failed');
      }
    }

    if (this.sessionToken === token) {
      this.sessionToken = null;
    }

    let replayToken;
    try {
      replayToken = await this._getSessionToken();
    } catch (error) {
      if (error instanceof VascoAuthenticationError) {
        throw this._authenticationFailure();
      }
      throw error;
    }

    try {
      return await operation(replayToken);
    } catch (error) {
      if (error instanceof VascoAuthenticationError) {
        if (this.sessionToken === replayToken) {
          this.sessionToken = null;
        }
        throw this._authenticationFailure();
      }
      throw redactApiError(error, 'Vasco account operation failed');
    }
  }

  _authenticationFailure() {
    const error = new VascoAuthenticationError(AUTHENTICATION_MESSAGE);
    if (!this.authenticationNotificationSent) {
      this.authenticationNotificationSent = true;
      invokeSafely(this.notify, error);
    }
    return error;
  }

  _schedulePoll(polling, delayMs) {
    if (polling.stopped || this.polling !== polling) return;

    polling.timer = this.clock.setTimeout(() => {
      polling.timer = null;
      void this._poll(polling);
    }, delayMs);
  }

  async _poll(polling) {
    try {
      const configuration = await this.readConfiguration({ force: true });
      if (polling.stopped || this.polling !== polling) return;

      polling.consecutiveFailures = 0;
      invokeSafely(polling.onState, configuration);
      this._setAvailability(polling, true);
      this._schedulePoll(polling, polling.intervalMs);
    } catch (error) {
      if (polling.stopped || this.polling !== polling) return;

      polling.consecutiveFailures += 1;
      if (error instanceof VascoAuthenticationError || polling.consecutiveFailures >= 3) {
        this._setAvailability(polling, false, redactedPollingError(error));
      }
      const delayMs = Math.min(
        INITIAL_RETRY_DELAY_MS * (2 ** (polling.consecutiveFailures - 1)),
        MAX_RETRY_DELAY_MS,
      );
      this._schedulePoll(polling, delayMs);
    }
  }

  _setAvailability(polling, available, error) {
    if (polling.available === available) return;

    polling.available = available;
    invokeSafely(polling.onAvailability, available, error);
  }
}

function findDevice(configuration, identity) {
  const device = discoverVentilationDevices(configuration)
    .find(candidate => candidate.identity === identity);
  if (!device) {
    throw new VascoProtocolError('The Vasco ventilation device is missing from the account configuration');
  }
  return device;
}

function redactApiError(error, fallbackMessage) {
  if (error instanceof VascoAuthenticationError) {
    return new VascoAuthenticationError(AUTHENTICATION_MESSAGE);
  }
  if (error instanceof VascoTransportError) {
    return new VascoTransportError(fallbackMessage);
  }
  if (error instanceof VascoProtocolError) {
    return new VascoProtocolError(fallbackMessage);
  }
  return new Error(fallbackMessage);
}

function redactedPollingError(error) {
  if (error instanceof VascoAuthenticationError) {
    return new VascoAuthenticationError(AUTHENTICATION_MESSAGE);
  }
  if (error instanceof VascoTransportError) {
    return new VascoTransportError('Vasco cloud polling failed');
  }
  if (error instanceof VascoProtocolError) {
    return new VascoProtocolError('Vasco cloud polling returned invalid data');
  }
  return new Error('Vasco account polling failed');
}

function invokeSafely(callback, ...args) {
  try {
    const result = callback(...args);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // Consumer callbacks must not stop account polling or recovery.
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = { VascoAccountService };
