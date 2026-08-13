const { createHash } = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const fixture = require('../fixtures/account-multiple-devices');
const { VascoAccountService } = require('../../lib/vasco-account-service');
const { toDeviceState } = require('../../lib/vasco-device-mapper');
const { VascoProtocolError, VascoTransportError } = require('../../lib/vasco-errors');

const EMAIL = 'device-owner@example.invalid';
const PASSWORD = 'synthetic-device-password';
const NEW_EMAIL = 'replacement-device-owner@example.invalid';
const NEW_PASSWORD = 'synthetic-replacement-password';
const SECOND_EMAIL = 'second-replacement-owner@example.invalid';
const SECOND_PASSWORD = 'synthetic-second-replacement-password';
const KITCHEN_ID = createHash('sha256')
  .update('synthetic-gateway-west\u0000synthetic-device-kitchen')
  .digest('hex');
const NOW_MS = 1_725_100_000_000;

class HomeyDeviceDouble {
  configure({ settings = {}, data = { id: KITCHEN_ID }, app = {} } = {}) {
    this.settings = {
      vasco_email: EMAIL,
      vasco_password: PASSWORD,
      poll_interval: '60',
      default_duration_type: 'schedule',
      default_duration_minutes: 60,
      default_fireplace_minutes: 5,
      ...settings,
    };
    this.data = data;
    this.capabilities = new Map();
    this.capabilityWrites = [];
    this.capabilityListeners = new Map();
    this.availability = [];
    this.settingsWrites = [];
    this.logged = [];
    this.homey = {
      app,
      notifications: { createNotification: async () => undefined },
    };
    return this;
  }

  getSettings() {
    return { ...this.settings };
  }

  getData() {
    return { ...this.data };
  }

  async setSettings(settings) {
    this.settingsWrites.push({ ...settings });
    Object.assign(this.settings, settings);
  }

  registerCapabilityListener(capability, listener) {
    this.capabilityListeners.set(capability, listener);
  }

  getCapabilityValue(capability) {
    return this.capabilities.get(capability) ?? null;
  }

  async setCapabilityValue(capability, value) {
    this.capabilityWrites.push([capability, value]);
    this.capabilities.set(capability, value);
  }

  async setAvailable() {
    this.availability.push({ available: true });
  }

  async setUnavailable(message) {
    this.availability.push({ available: false, message });
  }

  log(...values) {
    this.logged.push(values);
  }

  error(...values) {
    this.logged.push(values);
  }
}

function loadDeviceClass() {
  const devicePath = require.resolve('../../drivers/vasco-kermi-x/device');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') {
      return { Device: HomeyDeviceDouble };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[devicePath];
    return require(devicePath);
  } finally {
    Module._load = originalLoad;
  }
}

const VascoDevice = loadDeviceClass();

class AccountServiceDouble {
  constructor(configuration = fixture) {
    this.accountKey = 'synthetic-account-key';
    this.configuration = configuration;
    this.reads = [];
    this.commands = [];
    this.pollingStarts = [];
    this.pollingStops = 0;
    this.credentialUpdates = [];
    this.credentials = { email: EMAIL, password: PASSWORD };
  }

  async readConfiguration(options = {}) {
    this.reads.push(options);
    return this.configuration;
  }

  async executeDeviceCommand(identity, build, confirm) {
    const raw = structuredClone(fixture.deviceProperties[0]);
    const command = build(raw);
    this.commands.push({ identity, command });
    const state = {
      mode: command.requestedLevel,
      requestedMode: command.requestedLevel,
      controlMode: command.controlMode,
      manualSettingActiveTill: command.manualSettingActiveTill,
      fanSpeedInlet: 41,
      fanSpeedExhaust: 39,
      indoorTemperature: 21.4,
      outdoorTemperature: 8.1,
      bypassPosition: 0,
      filterDirty: 0,
      defrost: 0,
      faultStatus: 0,
      rfCommunicationStatus: 1,
      fireplaceModeStatus: command.fireplaceModeStatus,
      fireplaceModeTime: command.fireplaceModeTime,
    };
    if (!confirm(state)) throw new VascoProtocolError('confirmation rejected');
    return state;
  }

  startPolling(intervalSeconds, onState, onAvailability) {
    this.pollingStarts.push({ intervalSeconds, onState, onAvailability });
  }

  stopPolling() {
    this.pollingStops += 1;
  }

  async updateCredentials(email, password) {
    const previous = this.credentials;
    this.credentialUpdates.push({ email, password });
    this.credentials = { email, password };
    this.accountKey = email === EMAIL
      ? 'synthetic-account-key'
      : 'synthetic-rekeyed-account';
    return createTestCredentialRollback(async () => {
      this.credentialUpdates.push(previous);
      this.credentials = previous;
      this.accountKey = previous.email === EMAIL
        ? 'synthetic-account-key'
        : 'synthetic-rekeyed-account';
    });
  }
}

function createTestCredentialRollback(rollback = async () => undefined) {
  let active = true;
  return {
    async rollback() {
      if (!active) throw new Error('test credential rollback is no longer active');
      active = false;
      await rollback();
    },
    discard() {
      active = false;
    },
  };
}

class AccountRegistryDouble {
  constructor(service) {
    this.service = service;
    this.acquisitions = [];
    this.releases = [];
  }

  acquire(credentials) {
    this.acquisitions.push(credentials);
    return this.service;
  }

  release(accountKey) {
    this.releases.push(accountKey);
    return true;
  }
}

function createHarness({ service = new AccountServiceDouble(), settings, app } = {}) {
  const transitions = [];
  const transitionApp = app ?? {
    onVascoDeviceTransition: async (device, event, tokens) => {
      transitions.push({ device, event, tokens });
    },
  };
  const registry = new AccountRegistryDouble(service);
  const device = new VascoDevice().configure({ settings, app: transitionApp });
  device.getAccountRegistry = () => registry;
  device.getNow = () => NOW_MS;
  return { device, registry, service, transitions };
}

async function settle() {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

test('initialization acquires the shared account, registers controls, syncs before polling, and skips null values', async () => {
  const configuration = structuredClone(fixture);
  delete configuration.deviceProperties[0].outdoorTemperature;
  const service = new AccountServiceDouble(configuration);
  const { device, registry, transitions } = createHarness({ service });
  device.capabilities.set('measure_temperature.outdoor', 17.5);

  await device.onInit();

  assert.deepEqual(registry.acquisitions, [{ email: EMAIL, password: PASSWORD }]);
  assert.deepEqual([...device.capabilityListeners.keys()].sort(), [
    'button.test_connection',
    'vasco_fireplace',
    'vasco_mode',
  ]);
  assert.equal(service.reads.length, 1);
  assert.equal(service.pollingStarts.length, 1);
  assert.equal(service.pollingStarts[0].intervalSeconds, 60);
  assert.equal(device.capabilities.get('vasco_mode'), 'high');
  assert.equal(device.capabilities.get('measure_temperature.indoor'), 21.4);
  assert.equal(device.capabilities.get('measure_temperature.outdoor'), 17.5);
  assert.equal(device.capabilityWrites.some(([id]) => id === 'measure_temperature.outdoor'), false);
  assert.equal(device.capabilities.get('alarm_rf'), false);
  assert.deepEqual(transitions, []);
  assert.deepEqual(device.availability, [{ available: true }]);
});

test('applyState writes only changed non-null capabilities and emits post-initialization transitions', async () => {
  const { device, transitions } = createHarness();
  await device.applyState({
    requestedMode: 2,
    indoorTemperature: 21,
    outdoorTemperature: null,
    fanSpeedInlet: 40,
    fanSpeedExhaust: 38,
    bypassPosition: 5,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
    fireplaceModeStatus: 0,
    filterDirty: 0,
    faultStatus: 1,
    defrost: 0,
    rfCommunicationStatus: 1,
  }, { initial: true });
  device.capabilityWrites.length = 0;

  await device.applyState({
    requestedMode: 3,
    indoorTemperature: 21,
    outdoorTemperature: null,
    fanSpeedInlet: 40,
    fanSpeedExhaust: 38,
    bypassPosition: 5,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
    fireplaceModeStatus: 1,
    filterDirty: 1,
    faultStatus: 0,
    defrost: 0,
    rfCommunicationStatus: 1,
  }, { initial: false });

  assert.deepEqual(device.capabilityWrites, [
    ['vasco_mode', 'high'],
    ['vasco_fireplace', true],
    ['alarm_filter', true],
    ['alarm_generic', false],
  ]);
  assert.deepEqual(transitions.map(({ event, tokens }) => ({ event, tokens })), [
    { event: 'mode_changed', tokens: { previous_mode: 'medium', new_mode: 'high' } },
    { event: 'fireplace_enabled', tokens: {} },
    { event: 'filter_warning_appeared', tokens: {} },
    { event: 'fault_cleared', tokens: {} },
  ]);
});

test('the mode picker uses the configured default duration and applies confirmed state immediately', async () => {
  const { device, service } = createHarness({
    settings: {
      default_duration_type: 'minutes',
      default_duration_minutes: 30,
    },
  });
  await device.onInit();

  await device.capabilityListeners.get('vasco_mode')('auto');

  assert.equal(service.commands.length, 1);
  assert.equal(service.commands[0].identity, KITCHEN_ID);
  assert.deepEqual(service.commands[0].command, {
    ...fixture.deviceProperties[0],
    requestedLevel: 4,
    controlMode: 'manual',
    manualSettingActiveTill: NOW_MS + (30 * 60_000),
  });
  assert.equal(device.capabilities.get('vasco_mode'), 'auto');
});

test('the Fireplace switch sends the configured enable duration and applies confirmation immediately', async () => {
  const { device, service } = createHarness({
    settings: { default_fireplace_minutes: 45 },
  });
  await device.onInit();

  await device.capabilityListeners.get('vasco_fireplace')(true);

  assert.deepEqual(service.commands[0].command, {
    ...fixture.deviceProperties[0],
    fireplaceModeStatus: 1,
    fireplaceModeTime: 45,
  });
  assert.equal(device.capabilities.get('vasco_fireplace'), true);
});

test('unconfirmed commands restore the observed state and expose only a fixed error', async () => {
  const secret = 'private-upstream-response';
  const observed = structuredClone(fixture);
  observed.deviceProperties[0].requestedLevel = 1;
  const service = new AccountServiceDouble(observed);
  service.executeDeviceCommand = async () => {
    throw new VascoProtocolError(`${secret}: command rejected`);
  };
  const { device } = createHarness({ service });
  await device.onInit();
  device.capabilities.set('vasco_mode', 'high');

  await assert.rejects(
    () => device.setOperatingMode('auto', { type: 'schedule' }),
    (error) => {
      assert.match(error.message, /confirm|mode/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.equal(device.capabilities.get('vasco_mode'), 'low');
});

test('shared polling marks a device unavailable only after three transport failures and recovers it', async () => {
  const clock = new FakeClock();
  const outcomes = [
    fixture,
    new VascoTransportError('one'),
    new VascoTransportError('two'),
    new VascoTransportError('three'),
    fixture,
  ];
  const service = new VascoAccountService({
    apiClient: {
      login: async () => 'synthetic-token',
      getAccountConfiguration: async () => {
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
    email: EMAIL,
    password: PASSWORD,
    clock,
  });
  const { device, transitions } = createHarness({ service });
  await device.onInit();

  clock.advance(60_000);
  await settle();
  clock.advance(30_000);
  await settle();
  assert.deepEqual(device.availability, [{ available: true }]);
  clock.advance(60_000);
  await settle();
  assert.equal(device.availability.at(-1).available, false);
  assert.doesNotMatch(device.availability.at(-1).message, /one|two|three/);
  clock.advance(120_000);
  await settle();
  assert.equal(device.availability.at(-1).available, true);
  assert.deepEqual(transitions.map(({ event }) => event), [
    'device_became_unavailable',
    'device_became_available',
  ]);
});

test('the Maintenance Action forces a fresh read, updates state, and restores availability', async () => {
  const updated = structuredClone(fixture);
  updated.deviceProperties[0].requestedLevel = 6;
  const service = new AccountServiceDouble(fixture);
  const { device } = createHarness({ service });
  await device.onInit();
  service.configuration = updated;
  device.availability.length = 0;

  const result = await device.capabilityListeners.get('button.test_connection')();

  assert.equal(result, true);
  assert.deepEqual(service.reads.at(-1), { force: true });
  assert.equal(device.capabilities.get('vasco_mode'), 'holidays');
  assert.deepEqual(device.availability, []);
});

test('credential settings validate and rekey before polling is rescheduled or deletion releases the account', async () => {
  const credentialValidation = deferred();
  const service = new AccountServiceDouble();
  service.updateCredentials = async (email, password) => {
    service.credentialUpdates.push({ email, password });
    await credentialValidation.promise;
    service.accountKey = 'synthetic-rekeyed-account';
    return createTestCredentialRollback();
  };
  const { device, registry } = createHarness({ service });
  await device.onInit();

  const settingsUpdate = device.onSettings({
    oldSettings: device.getSettings(),
    newSettings: {
      ...device.getSettings(),
      vasco_email: NEW_EMAIL,
      vasco_password: NEW_PASSWORD,
      poll_interval: '120',
    },
    changedKeys: ['vasco_email', 'vasco_password', 'poll_interval'],
  });
  await settle();
  assert.equal(service.pollingStarts.length, 1);
  assert.deepEqual(service.credentialUpdates, [{ email: NEW_EMAIL, password: NEW_PASSWORD }]);

  credentialValidation.resolve();
  assert.equal(await settingsUpdate, undefined);
  assert.equal(service.pollingStarts.length, 2);
  assert.equal(service.pollingStarts.at(-1).intervalSeconds, 120);

  await device.onDeleted();
  assert.deepEqual(registry.releases, ['synthetic-rekeyed-account']);
});

test('failed credential validation preserves the old account and polling schedule without leaking credentials', async () => {
  const service = new AccountServiceDouble();
  service.updateCredentials = async () => {
    throw new Error(`${NEW_EMAIL}:${NEW_PASSWORD}`);
  };
  const { device, registry } = createHarness({ service });
  await device.onInit();

  await assert.rejects(
    () => device.onSettings({
      oldSettings: device.getSettings(),
      newSettings: {
        ...device.getSettings(),
        vasco_email: NEW_EMAIL,
        vasco_password: NEW_PASSWORD,
        poll_interval: '120',
      },
      changedKeys: ['vasco_email', 'vasco_password', 'poll_interval'],
    }),
    (error) => {
      assert.match(error.message, /credentials|settings/i);
      assert.doesNotMatch(error.message, new RegExp(NEW_EMAIL));
      assert.doesNotMatch(error.message, new RegExp(NEW_PASSWORD));
      return true;
    },
  );
  assert.equal(service.accountKey, 'synthetic-account-key');
  assert.equal(service.pollingStarts.length, 1);

  await device.onDeleted();
  assert.deepEqual(registry.releases, ['synthetic-account-key']);
  assert.equal(device.logged.flat().join(' ').includes(NEW_PASSWORD), false);
});

test('invalid local settings are rejected before credential validation or polling changes', async () => {
  const { device, service } = createHarness();
  await device.onInit();

  await assert.rejects(
    () => device.onSettings({
      oldSettings: device.getSettings(),
      newSettings: {
        ...device.getSettings(),
        vasco_email: NEW_EMAIL,
        vasco_password: NEW_PASSWORD,
        poll_interval: '31',
      },
      changedKeys: ['vasco_email', 'vasco_password', 'poll_interval'],
    }),
    /polling interval/i,
  );
  assert.deepEqual(service.credentialUpdates, []);
  assert.equal(service.pollingStarts.length, 1);
});

test('an invalid stored mode duration is rejected even while schedule mode is selected', async () => {
  const { device, service } = createHarness();
  await device.onInit();

  await assert.rejects(
    () => device.onSettings({
      oldSettings: device.getSettings(),
      newSettings: {
        ...device.getSettings(),
        default_duration_type: 'schedule',
        default_duration_minutes: 0,
      },
      changedKeys: ['default_duration_minutes'],
    }),
    /duration/i,
  );
  assert.deepEqual(service.credentialUpdates, []);
  assert.equal(service.pollingStarts.length, 1);
});

test('devices sharing one account share one polling loop and both receive its state', async () => {
  const service = new AccountServiceDouble();
  const registry = new AccountRegistryDouble(service);
  const first = new VascoDevice().configure();
  const second = new VascoDevice().configure();
  first.getAccountRegistry = () => registry;
  second.getAccountRegistry = () => registry;

  await first.onInit();
  await second.onInit();
  assert.equal(service.pollingStarts.length, 1);

  const updated = structuredClone(fixture);
  updated.deviceProperties[0].requestedLevel = 7;
  await service.pollingStarts[0].onState(updated);

  assert.equal(first.capabilities.get('vasco_mode'), 'guests');
  assert.equal(second.capabilities.get('vasco_mode'), 'guests');
  await first.onDeleted();
  await second.onDeleted();
  assert.deepEqual(registry.releases, ['synthetic-account-key', 'synthetic-account-key']);
  assert.equal(service.pollingStops, 1);
});

test('credential replacement is persisted across every device sharing the account', async () => {
  const service = new AccountServiceDouble();
  const registry = new AccountRegistryDouble(service);
  const first = new VascoDevice().configure();
  const second = new VascoDevice().configure();
  first.getAccountRegistry = () => registry;
  second.getAccountRegistry = () => registry;
  await first.onInit();
  await second.onInit();

  await first.onSettings({
    oldSettings: first.getSettings(),
    newSettings: {
      ...first.getSettings(),
      vasco_email: NEW_EMAIL,
      vasco_password: NEW_PASSWORD,
    },
    changedKeys: ['vasco_email', 'vasco_password'],
  });

  assert.deepEqual(second.settingsWrites, [{
    vasco_email: NEW_EMAIL,
    vasco_password: NEW_PASSWORD,
  }]);
  assert.equal(second.getSettings().vasco_email, NEW_EMAIL);
  assert.equal(second.getSettings().vasco_password, NEW_PASSWORD);
});

test('credential replacement stops the old polling generation before shared persistence', async () => {
  const service = new AccountServiceDouble();
  const registry = new AccountRegistryDouble(service);
  const first = new VascoDevice().configure();
  const second = new VascoDevice().configure();
  const persistenceStarted = deferred();
  const allowPersistence = deferred();
  first.getAccountRegistry = () => registry;
  second.getAccountRegistry = () => registry;
  await first.onInit();
  await second.onInit();
  const originalSetSettings = second.setSettings.bind(second);
  second.setSettings = async (settings) => {
    persistenceStarted.resolve();
    await allowPersistence.promise;
    return originalSetSettings(settings);
  };

  const update = first.onSettings({
    oldSettings: first.getSettings(),
    newSettings: {
      ...first.getSettings(),
      vasco_email: NEW_EMAIL,
      vasco_password: NEW_PASSWORD,
    },
    changedKeys: ['vasco_email', 'vasco_password'],
  });
  await persistenceStarted.promise;

  assert.equal(service.pollingStops, 1);
  assert.equal(service.pollingStarts.length, 1);
  allowPersistence.resolve();
  await update;
  assert.equal(service.pollingStarts.length, 2);
});

test('failed shared settings persistence rolls credentials and sibling settings back atomically', async () => {
  const service = new AccountServiceDouble();
  service.updateCredentials = async (email, password) => {
    service.credentialUpdates.push({ email, password });
    service.accountKey = email === NEW_EMAIL
      ? 'synthetic-rekeyed-account'
      : 'synthetic-account-key';
    return createTestCredentialRollback(async () => {
      service.credentialUpdates.push({ email: EMAIL, password: PASSWORD });
      service.accountKey = 'synthetic-account-key';
    });
  };
  const registry = new AccountRegistryDouble(service);
  const first = new VascoDevice().configure();
  const second = new VascoDevice().configure();
  const third = new VascoDevice().configure();
  first.getAccountRegistry = () => registry;
  second.getAccountRegistry = () => registry;
  third.getAccountRegistry = () => registry;
  await first.onInit();
  await second.onInit();
  await third.onInit();
  third.setSettings = async () => {
    throw new Error('synthetic settings persistence failure');
  };

  await assert.rejects(
    () => first.onSettings({
      oldSettings: first.getSettings(),
      newSettings: {
        ...first.getSettings(),
        vasco_email: NEW_EMAIL,
        vasco_password: NEW_PASSWORD,
      },
      changedKeys: ['vasco_email', 'vasco_password'],
    }),
    /settings were not changed/i,
  );

  assert.deepEqual(service.credentialUpdates, [
    { email: NEW_EMAIL, password: NEW_PASSWORD },
    { email: EMAIL, password: PASSWORD },
  ]);
  assert.equal(service.accountKey, 'synthetic-account-key');
  assert.equal(second.getSettings().vasco_email, EMAIL);
  assert.equal(second.getSettings().vasco_password, PASSWORD);
});

test('device credential success discards the service-owned rollback handle', async () => {
  const service = new AccountServiceDouble();
  let discarded = 0;
  service.updateCredentials = async (email, password) => {
    service.credentialUpdates.push({ email, password });
    return {
      rollback: async () => undefined,
      discard: () => { discarded += 1; },
    };
  };
  const { device } = createHarness({ service });
  await device.onInit();

  await device.onSettings({
    oldSettings: device.getSettings(),
    newSettings: {
      ...device.getSettings(),
      vasco_email: NEW_EMAIL,
      vasco_password: NEW_PASSWORD,
    },
    changedKeys: ['vasco_email', 'vasco_password'],
  });

  assert.equal(discarded, 1);
});

test('device rollback uses the opaque service handle instead of retaining raw credentials', async () => {
  const service = new AccountServiceDouble();
  let currentCredentials = { email: EMAIL, password: PASSWORD };
  let opaqueRollbacks = 0;
  service.updateCredentials = async (email, password) => {
    if (email === EMAIL && service.credentialUpdates.length > 0) {
      throw new Error('raw credential rollback is forbidden');
    }
    service.credentialUpdates.push({ email, password });
    const previous = currentCredentials;
    currentCredentials = { email, password };
    return {
      rollback: async () => {
        opaqueRollbacks += 1;
        currentCredentials = previous;
      },
      discard: () => undefined,
    };
  };
  const registry = new AccountRegistryDouble(service);
  const first = new VascoDevice().configure();
  const second = new VascoDevice().configure();
  first.getAccountRegistry = () => registry;
  second.getAccountRegistry = () => registry;
  await first.onInit();
  await second.onInit();
  second.setSettings = async () => {
    throw new Error('synthetic settings persistence failure');
  };

  await assert.rejects(
    () => first.onSettings({
      oldSettings: first.getSettings(),
      newSettings: {
        ...first.getSettings(),
        vasco_email: NEW_EMAIL,
        vasco_password: NEW_PASSWORD,
      },
      changedKeys: ['vasco_email', 'vasco_password'],
    }),
    /settings were not changed/i,
  );

  assert.equal(opaqueRollbacks, 1);
  assert.deepEqual(currentCredentials, { email: EMAIL, password: PASSWORD });
  assert.deepEqual(service.credentialUpdates, [
    { email: NEW_EMAIL, password: NEW_PASSWORD },
  ]);
});

test('a queued credential failure rolls back to the preceding committed replacement', async () => {
  const firstValidationStarted = deferred();
  const allowFirstValidation = deferred();
  const service = new AccountServiceDouble();
  let currentCredentials = { email: EMAIL, password: PASSWORD };
  service.updateCredentials = async (email, password) => {
    const previous = currentCredentials;
    service.credentialUpdates.push({ email, password });
    currentCredentials = { email, password };
    if (service.credentialUpdates.length === 1) {
      firstValidationStarted.resolve();
      await allowFirstValidation.promise;
    }
    return createTestCredentialRollback(async () => {
      service.credentialUpdates.push(previous);
      currentCredentials = previous;
    });
  };
  const registry = new AccountRegistryDouble(service);
  const first = new VascoDevice().configure();
  const second = new VascoDevice().configure();
  first.getAccountRegistry = () => registry;
  second.getAccountRegistry = () => registry;
  await first.onInit();
  await second.onInit();
  const originalSetSettings = second.setSettings.bind(second);
  second.setSettings = async (settings) => {
    if (settings.vasco_email === SECOND_EMAIL) {
      throw new Error('synthetic second persistence failure');
    }
    return originalSetSettings(settings);
  };

  const firstUpdate = first.onSettings({
    oldSettings: first.getSettings(),
    newSettings: {
      ...first.getSettings(),
      vasco_email: NEW_EMAIL,
      vasco_password: NEW_PASSWORD,
    },
    changedKeys: ['vasco_email', 'vasco_password'],
  });
  await firstValidationStarted.promise;
  const queuedUpdate = first.onSettings({
    oldSettings: first.getSettings(),
    newSettings: {
      ...first.getSettings(),
      vasco_email: SECOND_EMAIL,
      vasco_password: SECOND_PASSWORD,
    },
    changedKeys: ['vasco_email', 'vasco_password'],
  });
  allowFirstValidation.resolve();

  await firstUpdate;
  await assert.rejects(() => queuedUpdate, /settings were not changed/i);
  assert.deepEqual(service.credentialUpdates, [
    { email: NEW_EMAIL, password: NEW_PASSWORD },
    { email: SECOND_EMAIL, password: SECOND_PASSWORD },
    { email: NEW_EMAIL, password: NEW_PASSWORD },
  ]);
  assert.equal(second.getSettings().vasco_email, NEW_EMAIL);
  assert.equal(second.getSettings().vasco_password, NEW_PASSWORD);
});

test('failed service compensation stops polling and reports incomplete credential recovery', async () => {
  const service = new AccountServiceDouble();
  service.updateCredentials = async (email, password) => {
    service.credentialUpdates.push({ email, password });
    return createTestCredentialRollback(async () => {
      throw new Error('synthetic credential rollback failure');
    });
  };
  const registry = new AccountRegistryDouble(service);
  const first = new VascoDevice().configure();
  const second = new VascoDevice().configure();
  first.getAccountRegistry = () => registry;
  second.getAccountRegistry = () => registry;
  await first.onInit();
  await second.onInit();
  const originalSetSettings = second.setSettings.bind(second);
  second.setSettings = async () => {
    throw new Error('synthetic settings persistence failure');
  };

  await assert.rejects(
    () => first.onSettings({
      oldSettings: first.getSettings(),
      newSettings: {
        ...first.getSettings(),
        vasco_email: NEW_EMAIL,
        vasco_password: NEW_PASSWORD,
      },
      changedKeys: ['vasco_email', 'vasco_password'],
    }),
    (error) => {
      assert.match(error.message, /recovery|re-enter|incomplete/i);
      assert.doesNotMatch(error.message, /not changed/i);
      assert.doesNotMatch(error.message, new RegExp(NEW_EMAIL));
      assert.doesNotMatch(error.message, new RegExp(NEW_PASSWORD));
      return true;
    },
  );

  assert.equal(service.pollingStarts.length, 1);
  assert.equal(first.availability.at(-1).available, false);
  assert.equal(second.availability.at(-1).available, false);

  await first.onSettings({
    oldSettings: first.getSettings(),
    newSettings: { ...first.getSettings(), poll_interval: '120' },
    changedKeys: ['poll_interval'],
  });
  await second.onSettings({
    oldSettings: second.getSettings(),
    newSettings: { ...second.getSettings(), poll_interval: '120' },
    changedKeys: ['poll_interval'],
  });
  assert.equal(service.pollingStarts.length, 1);

  service.updateCredentials = async (email, password) => {
    service.credentialUpdates.push({ email, password });
    return createTestCredentialRollback();
  };
  second.setSettings = originalSetSettings;
  await first.onSettings({
    oldSettings: first.getSettings(),
    newSettings: {
      ...first.getSettings(),
      vasco_email: NEW_EMAIL,
      vasco_password: NEW_PASSWORD,
      poll_interval: '120',
    },
    changedKeys: ['vasco_email', 'vasco_password'],
  });
  assert.equal(service.pollingStarts.length, 2);
  assert.equal(service.pollingStarts.at(-1).intervalSeconds, 120);
});

test('failed sibling compensation stops polling and reports incomplete credential recovery', async () => {
  const service = new AccountServiceDouble();
  const registry = new AccountRegistryDouble(service);
  const first = new VascoDevice().configure();
  const second = new VascoDevice().configure();
  const third = new VascoDevice().configure();
  first.getAccountRegistry = () => registry;
  second.getAccountRegistry = () => registry;
  third.getAccountRegistry = () => registry;
  await first.onInit();
  await second.onInit();
  await third.onInit();
  const originalSetSettings = second.setSettings.bind(second);
  second.setSettings = async (settings) => {
    if (settings.vasco_email === EMAIL) {
      throw new Error('synthetic sibling rollback failure');
    }
    return originalSetSettings(settings);
  };
  third.setSettings = async () => {
    throw new Error('synthetic settings persistence failure');
  };

  await assert.rejects(
    () => first.onSettings({
      oldSettings: first.getSettings(),
      newSettings: {
        ...first.getSettings(),
        vasco_email: NEW_EMAIL,
        vasco_password: NEW_PASSWORD,
      },
      changedKeys: ['vasco_email', 'vasco_password'],
    }),
    (error) => {
      assert.match(error.message, /recovery|re-enter|incomplete/i);
      assert.doesNotMatch(error.message, /not changed/i);
      return true;
    },
  );

  assert.equal(second.getSettings().vasco_email, NEW_EMAIL);
  assert.equal(service.pollingStarts.length, 1);
  assert.equal(first.availability.at(-1).available, false);
  assert.equal(second.availability.at(-1).available, false);
  assert.equal(third.availability.at(-1).available, false);
});

test('concurrent state applications are serialized in observation order', async () => {
  const { device, transitions } = createHarness();
  await device.onInit();
  transitions.length = 0;
  device.capabilityWrites.length = 0;
  const firstWrite = deferred();
  const releaseFirstWrite = deferred();
  const originalSetCapabilityValue = device.setCapabilityValue.bind(device);
  device.setCapabilityValue = async (capability, value) => {
    if (capability === 'vasco_mode' && value === 'medium') {
      firstWrite.resolve();
      await releaseFirstWrite.promise;
    }
    return originalSetCapabilityValue(capability, value);
  };
  const base = toDeviceState(fixture.deviceProperties[0]);

  const first = device.applyState({ ...base, requestedMode: 2 }, { initial: false });
  await firstWrite.promise;
  const second = device.applyState({ ...base, requestedMode: 1 }, { initial: false });
  await settle();
  releaseFirstWrite.resolve();
  await Promise.all([first, second]);

  assert.equal(device.capabilities.get('vasco_mode'), 'low');
  assert.deepEqual(transitions.map(({ event, tokens }) => ({ event, tokens })), [
    { event: 'mode_changed', tokens: { previous_mode: 'high', new_mode: 'medium' } },
    { event: 'mode_changed', tokens: { previous_mode: 'medium', new_mode: 'low' } },
  ]);
});

test('deletion prevents an in-flight synchronization from writing further state or triggers', async () => {
  const { device, transitions } = createHarness();
  await device.onInit();
  transitions.length = 0;
  device.capabilityWrites.length = 0;
  const firstWrite = deferred();
  const releaseFirstWrite = deferred();
  const originalSetCapabilityValue = device.setCapabilityValue.bind(device);
  device.setCapabilityValue = async (capability, value) => {
    if (device.capabilityWrites.length === 0) {
      firstWrite.resolve();
      await releaseFirstWrite.promise;
    }
    return originalSetCapabilityValue(capability, value);
  };
  const state = {
    ...toDeviceState(fixture.deviceProperties[0]),
    requestedMode: 2,
    indoorTemperature: 19,
  };

  const update = device.applyState(state, { initial: false });
  await firstWrite.promise;
  await device.onDeleted();
  releaseFirstWrite.resolve();
  await update;

  assert.equal(device.capabilityWrites.length, 1);
  assert.deepEqual(transitions, []);
});

test('a device missing from a successful account poll becomes unavailable and recovers after apply', async () => {
  const { device, service, transitions } = createHarness();
  await device.onInit();
  device.availability.length = 0;
  transitions.length = 0;
  const polling = service.pollingStarts[0];

  await polling.onState({ deviceProperties: [] });
  assert.equal(device.availability.at(-1).available, false);
  assert.deepEqual(transitions.map(({ event }) => event), ['device_became_unavailable']);

  await polling.onState(fixture);
  assert.equal(device.availability.at(-1).available, true);
  assert.deepEqual(transitions.map(({ event }) => event), [
    'device_became_unavailable',
    'device_became_available',
  ]);
});

test('initialization failure releases an acquired account reference', async () => {
  const { device, registry } = createHarness();
  device.registerCapabilityListener = () => {
    throw new Error('synthetic listener registration failure');
  };

  await assert.rejects(() => device.onInit(), /listener registration failure/);

  assert.deepEqual(registry.releases, ['synthetic-account-key']);
});

test('Fireplace disable remains blocked until its cloud payload is verified', async () => {
  const { device, service } = createHarness();
  await device.onInit();

  await assert.rejects(
    () => device.setFireplace(false, 5),
    /not supported/i,
  );
  assert.deepEqual(service.commands, []);
});

class FakeClock {
  constructor(nowMs = NOW_MS) {
    this.nowMs = nowMs;
    this.nextId = 1;
    this.timers = new Map();
  }

  now() {
    return this.nowMs;
  }

  setTimeout(fn, delayMs) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + delayMs, fn });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  advance(delayMs) {
    const target = this.nowMs + delayMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.nowMs = timer.at;
      timer.fn();
    }
    this.nowMs = target;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
