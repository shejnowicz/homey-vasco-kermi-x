const {
  VascoAuthenticationError,
  VascoProtocolError,
  VascoTransportError,
} = require('./vasco-errors');
const {
  discoverVentilationDevices,
  toDeviceState,
} = require('./vasco-device-mapper');
const { isFireplaceEnableCommand } = require('./vasco-command-builder');

const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 30 * 60_000;
const COMMAND_CONFIRMATION_ATTEMPTS = 4;
const COMMAND_CONFIRMATION_DELAY_MS = 1_000;
const AUTHENTICATION_BACKOFF = Symbol('authenticationBackoff');
const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: timer => clearTimeout(timer),
});
const AUTHENTICATION_MESSAGE = 'Vasco authentication failed; update the account credentials';

class VascoAccountService {
  constructor({
    apiClient,
    email,
    password,
    clock = DEFAULT_CLOCK,
    notify = () => {},
    onCredentialCommit = () => {},
  }) {
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
    if (typeof onCredentialCommit !== 'function') {
      throw new TypeError('onCredentialCommit must be a function');
    }

    this.apiClient = apiClient;
    Object.defineProperties(this, {
      email: sensitiveProperty(email),
      password: sensitiveProperty(password),
      session: sensitiveProperty(null),
    });
    this.clock = clock;
    this.notify = notify;
    this.onCredentialCommit = onCredentialCommit;

    this.loginPromise = null;
    this.credentialVersion = 0;
    this.activeRead = null;
    this.queuedForcedRead = null;
    this.commandChains = new Map();
    this.polling = null;
    this.authenticationNotificationSent = false;
    this.authenticationFailures = new WeakSet();
    this.authenticationFailureCount = 0;
    this.nextAuthenticationAttemptAt = 0;
  }

  readConfiguration({ force = false } = {}) {
    if (!this.activeRead) {
      return this._startRead();
    }

    if (!force && this.activeRead.credentialVersion === this.credentialVersion) {
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
    const previousEmail = this.email;
    const previousPassword = this.password;
    await this._replaceCredentials(email, password);
    return createCredentialRollback(this, previousEmail, previousPassword);
  }

  async _replaceCredentials(email, password) {
    if (!isNonEmptyString(email) || typeof password !== 'string' || password.length === 0) {
      throw new TypeError('Vasco account credentials are required');
    }

    let token;
    try {
      token = await this.apiClient.login(email, password);
    } catch (error) {
      throw redactApiError(error, 'Vasco credential validation failed');
    }

    this.onCredentialCommit(email);
    this.email = email;
    this.password = password;
    this.credentialVersion += 1;
    this.session = createSession(token);
    this.authenticationNotificationSent = false;
    this._resetAuthenticationBackoff();
  }

  _startRead() {
    const active = {
      promise: null,
      credentialVersion: this.credentialVersion,
    };
    const read = this._withSession(session => this.apiClient.getAccountConfiguration(session.token));
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
    let acknowledgedState = null;

    await this._withSession(async session => {
      await this.apiClient.setDeviceProperties(session.token, [command]);
      if (command.nextParameter === 'requestedLevel'
        && Number.isFinite(command.nextValue)
        && typeof this.apiClient.writeDeviceParameter === 'function') {
        await this.apiClient.writeDeviceParameter({
          userToken: session.token,
          configuration: before,
          raw: device.raw,
          command,
          parameterName: 'requestedLevel',
          value: requestedLevelWireValue(command.nextValue),
          expectedFunctionName: 'dataWritten',
          expectedParameter: 'requestedLevel',
          expectedValue: requestedLevelWireValue(command.nextValue),
        });
        const acknowledgedRaw = { ...command, level: command.nextValue };
        delete acknowledgedRaw.requestedLevel;
        acknowledgedState = toDeviceState(acknowledgedRaw);
      } else if (isFireplaceEnableCommand(command)
        && typeof this.apiClient.writeDeviceParameter === 'function') {
        await this.apiClient.writeDeviceParameter({
          userToken: session.token,
          configuration: before,
          raw: device.raw,
          command,
          parameterName: 'fireplaceModeTime',
          value: command.fireplaceModeTime,
          expectedFunctionName: 'dataWritten',
          expectedParameter: 'fireplaceModeTime',
          expectedValue: command.fireplaceModeTime,
        });
        acknowledgedState = toDeviceState({ ...command, fireplaceModeStatus: 1 });
      }
    });

    if (acknowledgedState && confirm(acknowledgedState)) {
      return acknowledgedState;
    }

    for (let attempt = 0; attempt < COMMAND_CONFIRMATION_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await this._delay(COMMAND_CONFIRMATION_DELAY_MS);
      }
      const after = await this.readConfiguration({ force: true });
      const confirmedDevice = findDevice(after, identity);
      const state = toDeviceState(confirmedDevice.raw);
      if (confirm(state)) return state;
    }
    throw new VascoProtocolError('Vasco device state did not confirm the requested command');
  }

  _delay(delayMs) {
    return new Promise(resolve => this.clock.setTimeout(resolve, delayMs));
  }

  _deleteCommandChain(identity, command) {
    if (this.commandChains.get(identity) === command) {
      this.commandChains.delete(identity);
    }
  }

  async _getSession() {
    if (this.session !== null) {
      return this.session;
    }
    if (this.loginPromise?.credentialVersion === this.credentialVersion) {
      return this.loginPromise.promise;
    }
    if (this.clock.now() < this.nextAuthenticationAttemptAt) {
      const error = new VascoAuthenticationError(AUTHENTICATION_MESSAGE);
      Object.defineProperty(error, AUTHENTICATION_BACKOFF, { value: true });
      throw error;
    }

    const login = {
      credentialVersion: this.credentialVersion,
      promise: null,
    };
    login.promise = this._login(
      login.credentialVersion,
      this.email,
      this.password,
    );
    this.loginPromise = login;
    login.promise.then(
      () => this._deleteLoginPromise(login),
      () => this._deleteLoginPromise(login),
    );
    return login.promise;
  }

  async _login(credentialVersion, email, password) {
    let token;
    try {
      token = await this.apiClient.login(email, password);
    } catch (error) {
      if (credentialVersion !== this.credentialVersion) {
        return this._getSession();
      }
      throw redactApiError(error, 'Vasco login failed');
    }

    if (credentialVersion !== this.credentialVersion) {
      return this._getSession();
    }
    const session = createSession(token);
    this.session = session;
    return session;
  }

  _deleteLoginPromise(login) {
    if (this.loginPromise === login) {
      this.loginPromise = null;
    }
  }

  async _withSession(operation) {
    let session;
    try {
      session = await this._getSession();
    } catch (error) {
      if (error instanceof VascoAuthenticationError) {
        if (error[AUTHENTICATION_BACKOFF]) throw error;
        throw this._authenticationFailure(error);
      }
      throw error;
    }

    try {
      const result = await operation(session);
      this._resetAuthenticationBackoff();
      return result;
    } catch (error) {
      if (!(error instanceof VascoAuthenticationError)) {
        throw redactApiError(error, 'Vasco account operation failed');
      }
    }

    let replaySession;
    try {
      replaySession = await this._reauthenticate(session);
    } catch (error) {
      if (error instanceof VascoAuthenticationError) {
        if (error[AUTHENTICATION_BACKOFF]) throw error;
        throw this._authenticationFailure(session);
      }
      throw error;
    }

    try {
      const result = await operation(replaySession);
      this._resetAuthenticationBackoff();
      return result;
    } catch (error) {
      if (error instanceof VascoAuthenticationError) {
        if (this.session === replaySession) {
          this.session = null;
        }
        throw this._authenticationFailure(replaySession);
      }
      throw redactApiError(error, 'Vasco account operation failed');
    }
  }

  _reauthenticate(rejectedSession) {
    if (rejectedSession.reauthentication) {
      return rejectedSession.reauthentication;
    }
    if (this.session === rejectedSession) {
      this.session = null;
    }
    rejectedSession.reauthentication = this._getSession();
    return rejectedSession.reauthentication;
  }

  _authenticationFailure(failureKey) {
    if (!this.authenticationFailures.has(failureKey)) {
      this.authenticationFailures.add(failureKey);
      this.authenticationFailureCount += 1;
      const delayMs = Math.min(
        INITIAL_RETRY_DELAY_MS * (2 ** (this.authenticationFailureCount - 1)),
        MAX_RETRY_DELAY_MS,
      );
      this.nextAuthenticationAttemptAt = this.clock.now() + delayMs;
    }
    const error = new VascoAuthenticationError(AUTHENTICATION_MESSAGE);
    if (!this.authenticationNotificationSent) {
      this.authenticationNotificationSent = true;
      invokeSafely(this.notify, error);
    }
    return error;
  }

  _resetAuthenticationBackoff() {
    this.authenticationFailures = new WeakSet();
    this.authenticationFailureCount = 0;
    this.nextAuthenticationAttemptAt = 0;
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

function requestedLevelWireValue(level) {
  return level <= 4 ? level + 1 : level;
}

function findDevice(configuration, identity) {
  const device = discoverVentilationDevices(configuration)
    .find(candidate => candidate.identity === identity);
  if (!device) {
    throw new VascoProtocolError('The Vasco ventilation device is missing from the account configuration');
  }
  return device;
}

function createSession(token) {
  return { token, reauthentication: null };
}

function createCredentialRollback(service, email, password) {
  let retainedEmail = email;
  let retainedPassword = password;
  let active = true;

  const discard = () => {
    retainedEmail = null;
    retainedPassword = null;
    active = false;
  };

  return Object.freeze({
    async rollback() {
      if (!active) {
        throw new VascoProtocolError('Vasco credential rollback is no longer available');
      }
      const rollbackEmail = retainedEmail;
      const rollbackPassword = retainedPassword;
      discard();
      await service._replaceCredentials(rollbackEmail, rollbackPassword);
    },
    discard,
  });
}

function sensitiveProperty(value) {
  return {
    value,
    writable: true,
    enumerable: false,
    configurable: false,
  };
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
