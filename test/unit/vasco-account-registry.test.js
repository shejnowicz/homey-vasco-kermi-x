const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('../fixtures/account-multiple-devices');
const { VascoAccountRegistry } = require('../../lib/vasco-account-registry');

const PASSWORD = 'correct-horse-fixture';

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }

  now() {
    return 1_725_000_000_000;
  }

  setTimeout(fn, delayMs) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { fn, delayMs });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }
}

function createRegistry(clock, factoryCalls) {
  return new VascoAccountRegistry({
    apiClientFactory: () => {
      factoryCalls.push('created');
      return {
        login: async () => 'fixture-token',
        getAccountConfiguration: async () => fixture,
      };
    },
    clock,
    notify: () => {},
  });
}

test('acquire shares a service by normalized-email SHA-256 key and exposes the key read-only', () => {
  const factoryCalls = [];
  const registry = createRegistry(new FakeClock(), factoryCalls);

  const first = registry.acquire({ email: ' Owner@Example.Invalid ', password: PASSWORD });
  const second = registry.acquire({ email: 'owner@example.invalid', password: PASSWORD });

  assert.equal(first, second);
  assert.equal(factoryCalls.length, 1);
  assert.match(first.accountKey, /^[a-f0-9]{64}$/);
  assert.notEqual(first.accountKey, 'owner@example.invalid');
  const key = first.accountKey;
  assert.throws(() => {
    first.accountKey = 'replacement';
  }, TypeError);
  assert.equal(first.accountKey, key);
});

test('release retains shared services until the final reference and then stops polling', () => {
  const clock = new FakeClock();
  const registry = createRegistry(clock, []);
  const first = registry.acquire({ email: 'owner@example.invalid', password: PASSWORD });
  registry.acquire({ email: 'OWNER@example.invalid', password: PASSWORD });
  first.startPolling(60, () => {}, () => {});
  assert.equal(clock.timers.size, 1);

  assert.equal(registry.release(first.accountKey), false);
  assert.equal(clock.timers.size, 1);
  assert.equal(registry.release(first.accountKey), true);
  assert.equal(clock.timers.size, 0);
  assert.equal(registry.release(first.accountKey), false);
});

test('different normalized emails receive independent account services', () => {
  const factoryCalls = [];
  const registry = createRegistry(new FakeClock(), factoryCalls);

  const owner = registry.acquire({ email: 'owner@example.invalid', password: PASSWORD });
  const guest = registry.acquire({ email: 'guest@example.invalid', password: PASSWORD });

  assert.notEqual(owner, guest);
  assert.notEqual(owner.accountKey, guest.accountKey);
  assert.equal(factoryCalls.length, 2);
});
