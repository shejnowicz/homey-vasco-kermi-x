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
  assert.equal(
    first.accountKey,
    'a1d5d4103d619e71d41f4d8e96798978615d95d0ed9f31a860b4524840fd8ccf',
  );
  const key = first.accountKey;
  assert.throws(() => {
    first.accountKey = 'replacement';
  }, TypeError);
  assert.equal(first.accountKey, key);
});

test('successful email replacement migrates the shared registry identity and reference count', async () => {
  const factoryCalls = [];
  const registry = createRegistry(new FakeClock(), factoryCalls);
  const service = registry.acquire({ email: 'owner@example.invalid', password: PASSWORD });
  const oldKey = service.accountKey;

  await service.updateCredentials('replacement@example.invalid', 'replacement-horse-fixture');
  const newKey = 'd85ad419e196c69d53fb71ba8d328b48515e6b76407f01ba856d966389ee9a80';
  const reacquired = registry.acquire({
    email: ' REPLACEMENT@example.invalid ',
    password: 'replacement-horse-fixture',
  });

  assert.equal(service.accountKey, newKey);
  assert.equal(reacquired, service);
  assert.equal(factoryCalls.length, 1);
  assert.equal(registry.release(oldKey), false);
  assert.equal(registry.release(newKey), false);
  assert.equal(registry.release(newKey), true);
});

test('failed email validation retains the old registry key, credentials, and session', async () => {
  const oldKey = 'a1d5d4103d619e71d41f4d8e96798978615d95d0ed9f31a860b4524840fd8ccf';
  const readTokens = [];
  let factoryCalls = 0;
  const registry = new VascoAccountRegistry({
    apiClientFactory: () => {
      factoryCalls += 1;
      return {
        login: async email => {
          if (email.toLowerCase() === 'replacement@example.invalid') {
            throw new Error('replacement validation failed');
          }
          return 'working-old-token';
        },
        getAccountConfiguration: async token => {
          readTokens.push(token);
          return fixture;
        },
      };
    },
    clock: new FakeClock(),
    notify: () => {},
  });
  const service = registry.acquire({ email: 'owner@example.invalid', password: PASSWORD });
  await service.readConfiguration();

  await assert.rejects(
    () => service.updateCredentials('replacement@example.invalid', 'replacement-horse-fixture'),
    /credential validation failed/,
  );
  await service.readConfiguration();

  assert.equal(service.accountKey, oldKey);
  assert.equal(factoryCalls, 1);
  assert.deepEqual(readTokens, ['working-old-token', 'working-old-token']);
  assert.equal(registry.release(oldKey), true);
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
