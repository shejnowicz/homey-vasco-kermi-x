const {
  VascoAuthenticationError,
  VascoProtocolError,
  VascoTransportError,
} = require('./vasco-errors');

const DEFAULT_BASE_URL = 'https://vasco.iqloud.eu/api/';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOCK = Object.freeze({
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: timer => clearTimeout(timer),
});

const OPERATIONS = {
  login: {
    endpoint: 'login',
    label: 'login',
  },
  accountConfiguration: {
    endpoint: 'getaccountconfiguration',
    label: 'get account configuration',
  },
  deviceProperties: {
    endpoint: 'setdeviceproperties',
    label: 'set device properties',
  },
};

class VascoApiClient {
  constructor({
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    clock = DEFAULT_CLOCK,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function');
    }
    if (!clock || typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') {
      throw new TypeError('clock must provide setTimeout and clearTimeout');
    }

    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
  }

  async login(email, password) {
    const payload = await this._post('login', {
      payload: JSON.stringify({ userInfo: { email, password } }),
    });

    if (!isObject(payload) || typeof payload.userToken !== 'string' || payload.userToken.length === 0) {
      throw new VascoProtocolError('Vasco login response is missing a user token');
    }

    return payload.userToken;
  }

  async getAccountConfiguration(userToken) {
    const payload = await this._post('accountConfiguration', { userToken });

    if (!isObject(payload)) {
      throw new VascoProtocolError('Vasco get account configuration response is malformed');
    }

    return payload;
  }

  async setDeviceProperties(userToken, deviceObjects) {
    const payload = await this._post('deviceProperties', {
      userToken,
      payload: JSON.stringify(deviceObjects),
    });

    if (!isObject(payload)) {
      throw new VascoProtocolError('Vasco set device properties response is malformed');
    }

    return payload;
  }

  async _post(operation, body) {
    const definition = OPERATIONS[operation];
    const controller = new AbortController();
    const timeout = this.clock.setTimeout(() => controller.abort(), this.timeoutMs);
    let response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${definition.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof VascoAuthenticationError || error instanceof VascoProtocolError || error instanceof VascoTransportError) {
        throw error;
      }

      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new VascoTransportError(`Vasco ${definition.label} request timed out`);
      }

      throw new VascoTransportError(`Vasco ${definition.label} request failed`);
    } finally {
      this.clock.clearTimeout(timeout);
    }

    if (!response || !response.ok) {
      if (response?.status === 401 || response?.status === 403) {
        throw new VascoAuthenticationError(`Vasco ${definition.label} authentication rejected`);
      }

      throw new VascoTransportError(`Vasco ${definition.label} request failed`);
    }

    let message;
    try {
      message = await response.json();
    } catch {
      throw new VascoProtocolError(`Vasco ${definition.label} response is not valid JSON`);
    }

    if (!isObject(message) || message.status !== 'success') {
      throw new VascoAuthenticationError(`Vasco ${definition.label} authentication rejected`);
    }

    return message.payload;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = { VascoApiClient };
