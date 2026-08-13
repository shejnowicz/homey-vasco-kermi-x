const { createHash } = require('node:crypto');

const { VascoAccountService } = require('./vasco-account-service');

class VascoAccountRegistry {
  constructor({ apiClientFactory, clock, notify } = {}) {
    if (typeof apiClientFactory !== 'function') {
      throw new TypeError('apiClientFactory must be a function');
    }
    if (notify !== undefined && typeof notify !== 'function') {
      throw new TypeError('notify must be a function');
    }

    this.apiClientFactory = apiClientFactory;
    this.clock = clock;
    this.notify = notify;
    this.accounts = new Map();
  }

  acquire({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    const accountKey = createHash('sha256').update(normalizedEmail).digest('hex');
    const existing = this.accounts.get(accountKey);
    if (existing) {
      existing.references += 1;
      return existing.service;
    }

    const service = new VascoAccountService({
      apiClient: this.apiClientFactory(),
      email: email.trim(),
      password,
      clock: this.clock,
      notify: this.notify,
    });
    Object.defineProperty(service, 'accountKey', {
      enumerable: true,
      configurable: false,
      get: () => accountKey,
      set: () => {
        throw new TypeError('accountKey is read-only');
      },
    });
    this.accounts.set(accountKey, { references: 1, service });
    return service;
  }

  release(accountKey) {
    const account = this.accounts.get(accountKey);
    if (!account) return false;

    account.references -= 1;
    if (account.references > 0) return false;

    account.service.stopPolling();
    this.accounts.delete(accountKey);
    return true;
  }
}

function normalizeEmail(email) {
  if (typeof email !== 'string' || email.trim().length === 0) {
    throw new TypeError('A Vasco account email is required');
  }
  return email.trim().toLowerCase();
}

module.exports = { VascoAccountRegistry };
