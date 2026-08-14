const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');

const fixture = require('../fixtures/account-multiple-devices');

const EMAIL = 'pairing@example.test';
const PASSWORD = 'synthetic-pairing-password';
const RAW_BRIDGE_ID = 'synthetic-gateway-west';
const RAW_DEVICE_ID = 'synthetic-device-kitchen';
const KITCHEN_ID = createHash('sha256')
  .update(`${RAW_BRIDGE_ID}\u0000${RAW_DEVICE_ID}`)
  .digest('hex');
const BEDROOM_ID = createHash('sha256')
  .update('synthetic-gateway-east\u0000synthetic-device-bedroom')
  .digest('hex');
const root = join(__dirname, '..', '..');

class FakePairSession {
  constructor() {
    this.handlers = new Map();
  }

  setHandler(name, handler) {
    this.handlers.set(name, handler);
  }

  emit(name, payload) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Missing pair handler: ${name}`);
    return handler(payload);
  }
}

function loadDriver() {
  const driverPath = require.resolve('../../drivers/vasco-kermi-x/driver');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') {
      return { Driver: class Driver {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[driverPath];
    return require(driverPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[driverPath];
  }
}

function createHarness({ configuration = fixture, pairedIds = [], registry } = {}) {
  const Driver = loadDriver();
  const driver = new Driver();
  const pairRegistry = registry ?? new FakeAccountRegistry(configuration);
  driver.createPairRegistry = () => pairRegistry;
  driver.getDevices = () => pairedIds.map(id => ({
    getData: () => ({ id }),
  }));
  const session = new FakePairSession();

  driver.onPair(session);
  return { driver, registry: pairRegistry, session };
}

class FakeAccountRegistry {
  constructor(configuration) {
    this.configuration = configuration;
    this.activeService = null;
    this.released = false;
  }

  acquire({ email, password }) {
    if (email !== EMAIL || password !== PASSWORD) {
      throw new Error(`rejected:${email}:${password}`);
    }

    const service = {
      accountKey: 'synthetic-account-key',
      readConfiguration: async () => this.configuration,
    };
    this.activeService = service;
    return service;
  }

  release(accountKey) {
    if (accountKey === this.activeService?.accountKey) {
      this.released = true;
      this.activeService = null;
      return true;
    }
    return false;
  }
}

test('pair login errors never expose supplied credentials', async () => {
  const { driver, session } = createHarness();

  await assert.rejects(
    session.emit('login', {
      email: 'private-user@example.test',
      password: 'private-password-value',
    }),
    (error) => {
      assert.match(error.message, /sign in|credentials/i);
      assert.doesNotMatch(error.message, /private-user@example\.test/);
      assert.doesNotMatch(error.message, /private-password-value/);
      return true;
    },
  );
  assert.doesNotMatch(JSON.stringify(driver), /private-user|private-password/);
});

test('pairing returns every compatible unit with opaque identity and protected credentials', async () => {
  const supportedConfiguration = {
    deviceProperties: fixture.deviceProperties.slice(0, 3),
  };
  const { registry, session } = createHarness({ configuration: supportedConfiguration });

  assert.equal(await session.emit('login', { email: EMAIL, password: PASSWORD }), true);
  const devices = await session.emit('list_devices');

  assert.deepEqual(devices.map(device => device.data.id), [KITCHEN_ID, BEDROOM_ID]);
  assert.deepEqual(devices.map(device => device.name), [
    'Kitchen ventilation',
    'Bedroom ventilation',
  ]);
  for (const device of devices) {
    assert.deepEqual(device.settings, {
      vasco_email: EMAIL,
      vasco_password: PASSWORD,
    });
    assert.deepEqual(device.store, { product: device.data.id === KITCHEN_ID ? 'Vasco X500' : 'Kermi X350' });
    assert.doesNotMatch(device.name, /synthetic-gateway|synthetic-device/);
    assert.doesNotMatch(JSON.stringify(device.data), /synthetic-gateway|synthetic-device/);
    assert.doesNotMatch(JSON.stringify(device.store), /synthetic-gateway|synthetic-device|pairing-password|pairing@example/);
  }
  assert.equal(registry.released, false);
  await session.emit('disconnect');
  assert.equal(registry.released, true);
  await assert.rejects(session.emit('list_devices'), /sign in/i);
});

test('pairing lists an X500 whose schedule reports no requested level', async () => {
  const x500 = {
    productCategory: 'ventilation',
    productTypeString: 'X500',
    swVersion: 26,
    macAddress: 'synthetic-real-shape-mac',
    serial: 'synthetic-real-shape-serial',
    level: 2,
    requestedLevel: null,
    controlMode: 'schedule',
    actualFanSpeedInlet: 50,
    actualFanSpeedExhaust: 50,
  };
  const { session } = createHarness({ configuration: { deviceProperties: [x500] } });

  await session.emit('login', { email: EMAIL, password: PASSWORD });
  const devices = await session.emit('list_devices');

  assert.equal(devices.length, 1);
  assert.equal(
    devices[0].data.id,
    createHash('sha256')
      .update('synthetic-real-shape-mac\u0000synthetic-real-shape-serial')
      .digest('hex'),
  );
  assert.equal(devices[0].store.product, 'X500');
});

test('mobile pairing may request the device list repeatedly until session disconnect', async () => {
  const { registry, session } = createHarness({
    configuration: { deviceProperties: fixture.deviceProperties.slice(0, 1) },
  });

  await session.emit('login', { email: EMAIL, password: PASSWORD });
  assert.equal((await session.emit('list_devices')).length, 1);
  assert.equal((await session.emit('list_devices')).length, 1);
  assert.equal(registry.released, false);

  await session.emit('disconnect');
  assert.equal(registry.released, true);
  await assert.rejects(session.emit('list_devices'), /sign in/i);
});

test('pairing omits identities that Homey already has paired', async () => {
  const supportedConfiguration = {
    deviceProperties: fixture.deviceProperties.slice(0, 3),
  };
  const { session } = createHarness({
    configuration: supportedConfiguration,
    pairedIds: [KITCHEN_ID],
  });

  await session.emit('login', { email: EMAIL, password: PASSWORD });
  const devices = await session.emit('list_devices');

  assert.deepEqual(devices.map(device => device.data.id), [BEDROOM_ID]);
});

test('raw identifiers are replaced in display names', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties = [configuration.deviceProperties[0]];
  configuration.deviceProperties[0].name = `${RAW_BRIDGE_ID} / ${RAW_DEVICE_ID}`;
  const { session } = createHarness({ configuration });

  await session.emit('login', { email: EMAIL, password: PASSWORD });
  const [device] = await session.emit('list_devices');

  assert.equal(device.name, 'Vasco X500 ventilation unit');
});

test('credentials embedded anywhere in remote names and products never leave protected settings', async () => {
  const placements = [
    secret => `${secret} public model`,
    secret => `public ${secret} model`,
    secret => `public model ${secret}`,
  ];
  const deviceProperties = placements.map((place, index) => ({
    ...structuredClone(fixture.deviceProperties[0]),
    bridgeId: `${RAW_BRIDGE_ID}-${index}`,
    deviceId: `${RAW_DEVICE_ID}-${index}`,
    name: `${place(EMAIL)} ${place(PASSWORD)}`,
    product: `${place(PASSWORD)} ${place(EMAIL)}`,
  }));
  const { session } = createHarness({ configuration: { deviceProperties } });

  await session.emit('login', { email: EMAIL, password: PASSWORD });
  const devices = await session.emit('list_devices');

  assert.equal(devices.length, 3);
  for (const device of devices) {
    assert.equal(device.name, 'Vasco ventilation unit');
    assert.deepEqual(device.store, { product: 'Vasco ventilation unit' });
    assert.equal(device.settings.vasco_email, EMAIL);
    assert.equal(device.settings.vasco_password, PASSWORD);
    for (const output of [device.name, JSON.stringify(device.store)]) {
      assert.equal(output.includes(EMAIL), false);
      assert.equal(output.includes(PASSWORD), false);
      assert.equal(output.includes(RAW_BRIDGE_ID), false);
      assert.equal(output.includes(RAW_DEVICE_ID), false);
    }
  }
});

test('malformed ventilation candidates produce a compatibility error without private references', async () => {
  const malformed = fixture.deviceProperties[3];
  const { registry, session } = createHarness({
    configuration: { deviceProperties: [malformed] },
  });

  await session.emit('login', { email: EMAIL, password: PASSWORD });
  await assert.rejects(
    session.emit('list_devices'),
    (error) => {
      assert.match(error.message, /Vasco X200/);
      assert.match(error.message, /compatib|support|report/i);
      assert.doesNotMatch(error.message, new RegExp(malformed.bridgeId));
      assert.doesNotMatch(error.message, new RegExp(malformed.deviceId));
      assert.doesNotMatch(error.message, new RegExp(EMAIL));
      assert.doesNotMatch(error.message, new RegExp(PASSWORD));
      return true;
    },
  );
  await session.emit('disconnect');
  assert.equal(registry.released, true);
});

test('malformed compatibility errors redact credentials embedded throughout the product', async () => {
  const malformed = {
    ...structuredClone(fixture.deviceProperties[3]),
    product: `${EMAIL} model ${PASSWORD} suffix ${EMAIL}`,
  };
  const { session } = createHarness({
    configuration: { deviceProperties: [malformed] },
  });

  await session.emit('login', { email: EMAIL, password: PASSWORD });
  await assert.rejects(
    session.emit('list_devices'),
    (error) => {
      assert.match(error.message, /compatib|support|report/i);
      for (const privateValue of [EMAIL, PASSWORD, malformed.bridgeId, malformed.deviceId]) {
        assert.equal(error.message.includes(privateValue), false);
      }
      return true;
    },
  );
});

test('a second login is rejected while the first is pending and the acquired reference is released', async () => {
  const registry = new DeferredAccountRegistry();
  const { session } = createHarness({ registry });

  const firstLogin = session.emit('login', { email: EMAIL, password: PASSWORD });
  const secondRejected = assert.rejects(
    session.emit('login', {
      email: 'overlap@example.test',
      password: 'overlap-private-password',
    }),
    (error) => {
      assert.match(error.message, /sign in|credentials/i);
      assert.doesNotMatch(error.message, /overlap@example\.test|overlap-private-password/);
      return true;
    },
  );
  await Promise.resolve();
  assert.equal(registry.acquisitions.length, 1);
  await secondRejected;

  registry.acquisitions[0].read.resolve({
    deviceProperties: fixture.deviceProperties.slice(0, 1),
  });
  assert.equal(await firstLogin, true);
  await session.emit('list_devices');
  await session.emit('disconnect');

  assert.equal(registry.active.size, 0);
  assert.equal(registry.containsCredentials(), false);
});

test('a failed deferred login releases its registry reference and credentials', async () => {
  const registry = new DeferredAccountRegistry();
  const { session } = createHarness({ registry });

  const login = session.emit('login', { email: EMAIL, password: PASSWORD });
  registry.acquisitions[0].read.reject(new Error(`remote:${EMAIL}:${PASSWORD}`));

  await assert.rejects(login, /sign in|credentials/i);
  assert.equal(registry.active.size, 0);
  assert.equal(registry.containsCredentials(), false);
});

test('disconnect during configuration discards the pairing result and releases its account once', async () => {
  const registry = new DeferredAccountRegistry();
  const { session } = createHarness({ registry });

  const login = session.emit('login', { email: EMAIL, password: PASSWORD });
  const [acquisition] = registry.acquisitions;

  await session.emit('disconnect');
  acquisition.read.resolve({
    deviceProperties: fixture.deviceProperties.slice(0, 1),
  });

  await assert.rejects(
    login,
    (error) => {
      assert.match(error.message, /sign in|credentials/i);
      assert.doesNotMatch(error.message, new RegExp(EMAIL));
      assert.doesNotMatch(error.message, new RegExp(PASSWORD));
      return true;
    },
  );
  await assert.rejects(session.emit('list_devices'), /sign in/i);
  await session.emit('disconnect');

  assert.deepEqual(registry.releases, [acquisition.accountKey]);
  assert.equal(registry.active.size, 0);
  assert.equal(registry.containsCredentials(), false);
});

test('Homey pairing uses a custom login followed by list and add templates', () => {
  const manifest = JSON.parse(readFileSync(
    join(root, 'drivers', 'vasco-kermi-x', 'driver.compose.json'),
    'utf8',
  ));

  assert.deepEqual(manifest.pair, [
    {
      id: 'login',
    },
    {
      id: 'list_devices',
      template: 'list_devices',
      navigation: { prev: 'login', next: 'add_devices' },
    },
    {
      id: 'add_devices',
      template: 'add_devices',
      navigation: { prev: 'list_devices' },
    },
  ]);
});

test('custom login awaits authentication before navigating and redacts failures', async () => {
  const html = readFileSync(
    join(root, 'drivers', 'vasco-kermi-x', 'pair', 'login.html'),
    'utf8',
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'login view must contain executable pairing behavior');

  const elements = new Map([
    ['login-form', fakeElement()],
    ['email', fakeElement({ value: EMAIL })],
    ['password', fakeElement({ value: PASSWORD })],
    ['submit', fakeElement()],
    ['error', fakeElement()],
  ]);
  const emitted = [];
  const views = [];
  const Homey = {
    ready() {},
    async emit(name, payload) {
      emitted.push({ name, payload });
      return true;
    },
    async showView(view) {
      views.push(view);
    },
  };
  vm.runInNewContext(script, {
    Homey,
    document: { getElementById: id => elements.get(id) },
  });

  await elements.get('login-form').listeners.submit({ preventDefault() {} });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, 'login');
  assert.equal(emitted[0].payload.email, EMAIL);
  assert.equal(emitted[0].payload.password, PASSWORD);
  assert.deepEqual(views, ['list_devices']);
  assert.equal(elements.get('error').textContent, '');

  Homey.emit = async () => {
    throw new Error(`rejected:${EMAIL}:${PASSWORD}`);
  };
  await elements.get('login-form').listeners.submit({ preventDefault() {} });
  assert.match(elements.get('error').textContent, /sign in|credentials/i);
  assert.doesNotMatch(elements.get('error').textContent, new RegExp(EMAIL));
  assert.doesNotMatch(elements.get('error').textContent, new RegExp(PASSWORD));
});

function fakeElement({ value = '' } = {}) {
  return {
    disabled: false,
    listeners: {},
    textContent: '',
    value,
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
  };
}

class DeferredAccountRegistry {
  constructor() {
    this.acquisitions = [];
    this.active = new Map();
    this.releases = [];
  }

  acquire(credentials) {
    const accountKey = `deferred-account-${this.acquisitions.length}`;
    const read = deferred();
    const acquisition = { accountKey, credentials, read };
    const service = {
      accountKey,
      readConfiguration: () => read.promise,
    };
    this.acquisitions.push(acquisition);
    this.active.set(accountKey, acquisition);
    return service;
  }

  release(accountKey) {
    this.releases.push(accountKey);
    return this.active.delete(accountKey);
  }

  containsCredentials() {
    const serialized = JSON.stringify([...this.active.values()]);
    return serialized.includes(EMAIL) || serialized.includes(PASSWORD);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
