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
  configure({
    settings = {},
    data = { id: KITCHEN_ID },
    app = {},
    clock = new FakeClock(),
  } = {}) {
    this.settings = {
      vasco_email: EMAIL,
      vasco_password: PASSWORD,
      poll_interval: '60',
      default_duration_type: 'schedule',
      default_duration_minutes: 60,
      ...settings,
    };
    this.data = data;
    this.capabilities = new Map();
    this.availableCapabilities = new Set();
    this.capabilityAdds = [];
    this.capabilityRemovals = [];
    this.capabilityWrites = [];
    this.capabilityListeners = new Map();
    this.availability = [];
    this.settingsWrites = [];
    this.store = {};
    this.storeWrites = [];
    this.storeRemovals = [];
    this.logged = [];
    this.clock = clock;
    this.homey = {
      app,
      notifications: { createNotification: async () => undefined },
      setTimeout: clock.setTimeout.bind(clock),
      clearTimeout: clock.clearTimeout.bind(clock),
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

  hasCapability(capability) {
    return this.availableCapabilities.has(capability);
  }

  async addCapability(capability) {
    this.capabilityAdds.push(capability);
    this.availableCapabilities.add(capability);
  }

  async removeCapability(capability) {
    this.capabilityRemovals.push(capability);
    this.availableCapabilities.delete(capability);
  }

  getStoreValue(key) {
    return this.store[key];
  }

  async setStoreValue(key, value) {
    this.storeWrites.push({ key, value });
    this.store[key] = value;
  }

  async unsetStoreValue(key) {
    this.storeRemovals.push(key);
    delete this.store[key];
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

test('device contract migration adds the missing controls and changes the pre-release duration default', async () => {
  const { device } = createHarness({
    settings: { default_duration_type: 'permanent' },
  });

  await device.ensureDeviceContract();

  assert.deepEqual(device.capabilityAdds, [
    'button.enable_fireplace',
    'measure_vasco_mode',
    'vasco_fireplace_duration',
    'measure_fireplace_remaining',
    'button.stop_fireplace',
  ]);
  assert.deepEqual(device.settingsWrites, [
    { default_duration_type: 'schedule' },
  ]);
  assert.deepEqual(device.capabilityWrites, [['vasco_fireplace_duration', '5']]);
  assert.equal(device.store.device_contract_version, 2);
});

test('Fireplace duration migration upgrades version one with the nearest supported picker value', async () => {
  const { device } = createHarness({
    settings: { default_fireplace_minutes: 43 },
  });
  device.store.device_contract_version = 1;
  device.availableCapabilities.add('button.enable_fireplace');
  device.availableCapabilities.add('measure_vasco_mode');

  await device.ensureDeviceContract();

  assert.deepEqual(device.capabilityAdds, [
    'vasco_fireplace_duration',
    'measure_fireplace_remaining',
    'button.stop_fireplace',
  ]);
  assert.deepEqual(device.capabilityWrites, [['vasco_fireplace_duration', '45']]);
  assert.equal(device.store.device_contract_version, 2);
});

test('Fireplace duration migration defaults missing legacy duration to five minutes', async () => {
  const { device } = createHarness({
    settings: { default_fireplace_minutes: undefined },
  });
  device.store.device_contract_version = 1;

  await device.ensureDeviceContract();

  assert.deepEqual(device.capabilityWrites, [['vasco_fireplace_duration', '5']]);
  assert.equal(device.store.device_contract_version, 2);
});

test('Fireplace duration migration preserves the picker after version two', async () => {
  const { device } = createHarness({
    settings: { default_fireplace_minutes: 85 },
  });
  device.store.device_contract_version = 2;
  device.capabilities.set('vasco_fireplace_duration', '20');
  for (const capability of [
    'button.enable_fireplace',
    'measure_vasco_mode',
    'vasco_fireplace_duration',
    'measure_fireplace_remaining',
    'button.stop_fireplace',
  ]) device.availableCapabilities.add(capability);

  await device.ensureDeviceContract();

  assert.deepEqual(device.settingsWrites, []);
  assert.deepEqual(device.capabilityWrites, []);
  assert.deepEqual(device.storeWrites, []);
  assert.equal(device.getCapabilityValue('vasco_fireplace_duration'), '20');
});

test('device contract migration completes before account acquisition and listener registration', async () => {
  const { device, registry } = createHarness({
    settings: { default_duration_type: 'permanent' },
  });
  const operations = [];
  const addCapability = device.addCapability.bind(device);
  const setSettings = device.setSettings.bind(device);
  const setCapabilityValue = device.setCapabilityValue.bind(device);
  const setStoreValue = device.setStoreValue.bind(device);
  const registerCapabilityListener = device.registerCapabilityListener.bind(device);
  const acquire = registry.acquire.bind(registry);

  device.addCapability = async (capability) => {
    operations.push(`add:${capability}`);
    await addCapability(capability);
  };
  device.setSettings = async (settings) => {
    operations.push('settings');
    await setSettings(settings);
  };
  device.setCapabilityValue = async (capability, value) => {
    operations.push(`capability:${capability}:${value}`);
    await setCapabilityValue(capability, value);
  };
  device.setStoreValue = async (key, value) => {
    operations.push(`store:${key}:${value}`);
    await setStoreValue(key, value);
  };
  registry.acquire = (credentials) => {
    operations.push('acquire');
    return acquire(credentials);
  };
  device.registerCapabilityListener = (capability, listener) => {
    operations.push(`listener:${capability}`);
    registerCapabilityListener(capability, listener);
  };

  await device.onInit();

  assert.deepEqual(operations.slice(0, operations.indexOf('acquire') + 1), [
    'add:button.enable_fireplace',
    'add:measure_vasco_mode',
    'add:vasco_fireplace_duration',
    'add:measure_fireplace_remaining',
    'add:button.stop_fireplace',
    'settings',
    'capability:vasco_fireplace_duration:5',
    'store:device_contract_version:2',
    'acquire',
  ]);
  assert.ok(operations.indexOf('listener:vasco_mode') > operations.indexOf('acquire'));
});

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
      mode: command.nextValue,
      requestedMode: command.nextValue,
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
      rfCommunicationStatus: 0,
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

function createHarness({
  service = new AccountServiceDouble(),
  settings,
  app,
  clock = new FakeClock(),
} = {}) {
  const transitions = [];
  const transitionApp = app ?? {
    onVascoDeviceTransition: async (device, event, tokens) => {
      transitions.push({ device, event, tokens });
    },
  };
  const registry = new AccountRegistryDouble(service);
  const device = new VascoDevice().configure({ settings, app: transitionApp, clock });
  device.getAccountRegistry = () => registry;
  device.getNow = () => clock.now();
  return {
    clock,
    device,
    registry,
    service,
    transitions,
  };
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
    'button.enable_fireplace',
    'button.stop_fireplace',
    'button.test_connection',
    'vasco_fireplace_duration',
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

test('Fireplace session restoration resumes remaining time and its minute countdown after restart', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const { clock, device } = createHarness({
    service: new AccountServiceDouble(configuration),
  });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 45,
    startedAt: NOW_MS - 10_000,
    endsAt: NOW_MS + (44 * 60_000) + 50_000,
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;

  await device.onInit();

  assert.deepEqual(device.fireplaceSession, session);
  assert.equal(device.capabilities.get('vasco_fireplace'), true);
  assert.equal(device.capabilities.get('measure_fireplace_remaining'), 45);
  assert.equal(device.capabilityListeners.has('vasco_fireplace_duration'), true);
  assert.equal(device.capabilityListeners.has('button.stop_fireplace'), true);
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].at, NOW_MS + 50_000);

  clock.advance(50_000);
  await settle();

  assert.equal(device.capabilities.get('measure_fireplace_remaining'), 44);
  assert.equal(clock.timers.size, 1);
});

test('Fireplace session restoration keeps counting down when the initial cloud read fails', async () => {
  const service = new AccountServiceDouble();
  service.readConfiguration = async (options = {}) => {
    service.reads.push(options);
    throw new VascoTransportError('private initial read failure');
  };
  const { clock, device } = createHarness({ service });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 45,
    startedAt: NOW_MS - 10_000,
    endsAt: NOW_MS + (44 * 60_000) + 50_000,
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;

  await device.onInit();

  assert.deepEqual(device.fireplaceSession, session);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), 45);
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].at, NOW_MS + 50_000);
  assert.equal(device.availability.at(-1).available, false);

  clock.advance(50_000);
  await settle();

  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), 44);
  assert.equal(clock.timers.size, 1);
});

test('Fireplace remaining time reaches zero, removes the session, and forces reconciliation', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const { clock, device, service } = createHarness({
    service: new AccountServiceDouble(configuration),
  });
  device.store.device_contract_version = 2;
  device.store.fireplace_session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  await device.onInit();

  for (let minute = 0; minute < 5; minute += 1) {
    clock.advance(60_000);
    await settle();
  }

  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.equal(device.clock.timers.size, 0);
  assert.equal(service.reads.length, 2);
  assert.equal(service.reads.at(-1).force, true);
  assert.equal(device.capabilityWrites.some(([capability, value]) => (
    capability === 'measure_fireplace_remaining' && value === 0
  )), true);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
});

test('Fireplace session timer is cleared by both deletion and Homey uninitialization', async (t) => {
  for (const lifecycle of ['onDeleted', 'onUninit']) {
    await t.test(lifecycle, async () => {
      const configuration = structuredClone(fixture);
      configuration.deviceProperties[0].fireplaceModeStatus = 1;
      const { clock, device } = createHarness({
        service: new AccountServiceDouble(configuration),
      });
      device.store.device_contract_version = 2;
      device.store.fireplace_session = {
        version: 1,
        priorMode: 'high',
        priorDuration: { type: 'schedule' },
        selectedMinutes: 5,
        startedAt: NOW_MS,
        endsAt: NOW_MS + (5 * 60_000),
      };
      await device.onInit();
      assert.equal(clock.timers.size, 1);

      await device[lifecycle]();

      assert.equal(clock.timers.size, 0);
      assert.equal(device.fireplaceTimer, null);
    });
  }
});

test('deletion stops an in-flight Fireplace countdown after its current capability write', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const { clock, device } = createHarness({
    service: new AccountServiceDouble(configuration),
  });
  device.store.device_contract_version = 2;
  device.store.fireplace_session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  await device.onInit();
  for (let minute = 0; minute < 4; minute += 1) {
    clock.advance(60_000);
    await settle();
  }

  const zeroWriteStarted = deferred();
  const allowZeroWrite = deferred();
  const setCapabilityValue = device.setCapabilityValue.bind(device);
  device.setCapabilityValue = async (capability, value) => {
    if (capability === 'measure_fireplace_remaining' && value === 0) {
      zeroWriteStarted.resolve();
      await allowZeroWrite.promise;
    }
    return setCapabilityValue(capability, value);
  };
  clock.advance(60_000);
  await zeroWriteStarted.promise;

  await device.onDeleted();
  allowZeroWrite.resolve();
  await settle();

  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), true);
  assert.equal(device.storeRemovals.includes('fireplace_session'), false);
  assert.equal(device.clock.timers.size, 0);
});

test('Fireplace session initialization removes malformed persisted data safely', async () => {
  const { clock, device } = createHarness();
  device.store.device_contract_version = 2;
  device.store.fireplace_session = {
    version: 1,
    token: 'must-not-survive',
  };
  device.capabilities.set('measure_fireplace_remaining', 12);

  await device.onInit();

  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.deepEqual(device.storeRemovals, ['fireplace_session']);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
  assert.equal(clock.timers.size, 0);
});

test('external Fireplace session activation reports unknown remaining time', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const { clock, device } = createHarness({
    service: new AccountServiceDouble(configuration),
  });
  device.store.device_contract_version = 2;
  device.capabilities.set('measure_fireplace_remaining', 12);

  await device.onInit();

  assert.equal(device.fireplaceSession, null);
  assert.equal(device.capabilities.get('vasco_fireplace'), true);
  assert.equal(device.capabilities.get('measure_fireplace_remaining'), null);
  assert.equal(clock.timers.size, 0);
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
    rfCommunicationStatus: 0,
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
    rfCommunicationStatus: 0,
  }, { initial: false });

  assert.deepEqual(device.capabilityWrites, [
    ['vasco_mode', 'high'],
    ['measure_vasco_mode', 3],
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

test('mode number synchronization writes each supported requested operating mode', async () => {
  const { device } = createHarness();
  const baseState = {
    indoorTemperature: 21,
    outdoorTemperature: 8,
    fanSpeedInlet: 40,
    fanSpeedExhaust: 38,
    bypassPosition: 5,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
    fireplaceModeStatus: 0,
    filterDirty: 0,
    faultStatus: 0,
    defrost: 0,
    rfCommunicationStatus: 0,
  };

  for (const [level, mode] of [
    [1, 'low'],
    [2, 'medium'],
    [3, 'high'],
    [4, 'auto'],
    [6, 'holidays'],
    [7, 'guests'],
  ]) {
    await device.applyState({ ...baseState, mode: level, requestedMode: level }, { initial: true });
    assert.equal(device.getCapabilityValue('vasco_mode'), mode);
    assert.equal(device.getCapabilityValue('measure_vasco_mode'), level);
  }
});

test('RF status zero is healthy and a non-zero status raises the alarm', async () => {
  const { device } = createHarness();

  await device.applyState({ rfCommunicationStatus: 0 }, { initial: true });
  assert.equal(device.capabilities.get('alarm_rf'), false);

  await device.applyState({ rfCommunicationStatus: 1 }, { initial: false });
  assert.equal(device.capabilities.get('alarm_rf'), true);
});

test('optimistic mode acknowledgement applies both mode values before a later poll', async () => {
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
    ...withoutRequestedLevel(fixture.deviceProperties[0]),
    nextParameter: 'requestedLevel',
    nextValue: 4,
    controlMode: 'manual',
    manualSettingActiveTill: NOW_MS + (30 * 60_000),
  });
  assert.equal(device.capabilities.get('vasco_mode'), 'auto');
  assert.equal(device.capabilities.get('measure_vasco_mode'), 4);
  assert.equal(service.reads.length, 1);
});

function withoutRequestedLevel(device) {
  const clone = structuredClone(device);
  delete clone.requestedLevel;
  return clone;
}

test('Fireplace enable persists the prior state before sending the picker duration and starts its countdown', async () => {
  const { device, service } = createHarness();
  device.store.device_contract_version = 2;
  device.capabilities.set('vasco_fireplace_duration', '45');
  const executeDeviceCommand = service.executeDeviceCommand.bind(service);
  let sessionAtCommand = null;
  service.executeDeviceCommand = async (...args) => {
    sessionAtCommand = structuredClone(device.store.fireplace_session);
    return executeDeviceCommand(...args);
  };
  await device.onInit();

  assert.equal(device.capabilityListeners.has('vasco_fireplace'), false);
  const press = device.capabilityListeners.get('button.enable_fireplace');
  await press();

  const expectedSession = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 45,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (45 * 60_000),
  };
  assert.deepEqual(sessionAtCommand, expectedSession);
  assert.deepEqual(device.fireplaceSession, expectedSession);
  assert.deepEqual(device.store.fireplace_session, expectedSession);
  assert.deepEqual(service.commands[0].command, {
    ...fixture.deviceProperties[0],
    fireplaceModeStatus: 1,
    fireplaceModeTime: 45,
  });
  assert.equal(device.capabilities.get('vasco_fireplace'), true);
  assert.equal(device.capabilities.get('measure_fireplace_remaining'), 45);
  assert.equal(device.clock.timers.size, 1);
  assert.equal([...device.clock.timers.values()][0].at, NOW_MS + 60_000);
});

test('Fireplace Flow and internal enable path accepts one through 1440 whole minutes', async (t) => {
  for (const minutes of [1, 90, 1_440]) {
    await t.test(`${minutes} minutes`, async () => {
      const { device, service } = createHarness();
      device.store.device_contract_version = 2;
      await device.onInit();

      await device.setFireplace(true, minutes);

      assert.equal(service.commands.length, 1);
      assert.equal(service.commands[0].command.fireplaceModeTime, minutes);
      assert.equal(device.fireplaceSession.selectedMinutes, minutes);
      assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), minutes);
    });
  }
});

test('Fireplace duration picker listener rejects values outside its five-minute choices', async () => {
  const { device, service } = createHarness();
  device.store.device_contract_version = 2;
  await device.onInit();
  const selectDuration = device.capabilityListeners.get('vasco_fireplace_duration');

  for (const minutes of [1, 6, 90, 1_440]) {
    assert.throws(() => selectDuration(String(minutes)), /five-minute value/i);
  }
  assert.deepEqual(service.commands, []);
});

test('failed Fireplace enable rolls back its managed session, countdown, and UI with a fixed error', async () => {
  const secret = 'private-fireplace-upstream-response';
  const service = new AccountServiceDouble();
  const { device } = createHarness({ service });
  device.store.device_contract_version = 2;
  device.capabilities.set('vasco_fireplace_duration', '45');
  let sessionAtCommand = null;
  service.executeDeviceCommand = async () => {
    sessionAtCommand = structuredClone(device.store.fireplace_session);
    throw new VascoProtocolError(`${secret}: command rejected`);
  };
  await device.onInit();

  await assert.rejects(
    () => device.capabilityListeners.get('button.enable_fireplace')(),
    (error) => {
      assert.equal(error.message, 'Vasco did not confirm Fireplace mode.');
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  assert.equal(sessionAtCommand.selectedMinutes, 45);
  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.equal(device.clock.timers.size, 0);
  assert.equal(device.capabilities.get('vasco_fireplace'), false);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
  assert.equal(device.logged.flat().join(' ').includes(secret), false);
});

test('failed Fireplace enable persistence rolls back locally without sending a command', async () => {
  const { device, service } = createHarness();
  device.store.device_contract_version = 2;
  device.capabilities.set('vasco_fireplace_duration', '45');
  const setStoreValue = device.setStoreValue.bind(device);
  device.setStoreValue = async (key, value) => {
    if (key === 'fireplace_session') {
      throw new Error('private synthetic store failure');
    }
    return setStoreValue(key, value);
  };
  await device.onInit();

  await assert.rejects(
    () => device.capabilityListeners.get('button.enable_fireplace')(),
    { message: 'Vasco did not confirm Fireplace mode.' },
  );

  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.equal(device.clock.timers.size, 0);
  assert.equal(device.getCapabilityValue('vasco_fireplace'), false);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
  assert.deepEqual(service.commands, []);
  assert.equal(device.logged.flat().join(' ').includes('private synthetic'), false);
});

test('failed Fireplace re-enable restores a prior stopped suppression timer', async () => {
  const secret = 'private-re-enable-response';
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const service = new AccountServiceDouble(configuration);
  const { device } = createHarness({ service });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();
  await device.capabilityListeners.get('button.stop_fireplace')();
  const stopped = structuredClone(device.fireplaceSession);

  service.executeDeviceCommand = async () => {
    throw new VascoProtocolError(`${secret}: command rejected`);
  };
  service.readConfiguration = async (options = {}) => {
    service.reads.push(options);
    throw new VascoTransportError(`${secret}: refresh unavailable`);
  };

  await assert.rejects(
    () => device.setFireplace(true, 45),
    { message: 'Vasco did not confirm Fireplace mode.' },
  );

  assert.deepEqual(device.fireplaceSession, stopped);
  assert.deepEqual(device.store.fireplace_session, stopped);
  assert.equal(device.getCapabilityValue('vasco_fireplace'), false);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
  assert.equal(device.clock.timers.size, 1);
  assert.equal([...device.clock.timers.values()][0].at, session.endsAt);
  assert.equal(device.logged.flat().join(' ').includes(secret), false);

  device.clock.advance(5 * 60_000);
  await settle();

  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.equal(device.clock.timers.size, 0);
});

test('Fireplace Stop restores permanent, schedule, and timed prior operating modes', async (t) => {
  const cases = [
    {
      name: 'permanent',
      priorMode: 'auto',
      priorDuration: { type: 'permanent' },
      expected: {
        nextValue: 4,
        controlMode: 'manual',
        manualSettingActiveTill: -1,
      },
    },
    {
      name: 'schedule',
      priorMode: 'high',
      priorDuration: { type: 'schedule' },
      expected: {
        nextValue: 3,
        controlMode: 'schedule',
        manualSettingActiveTill: 0,
      },
    },
    {
      name: 'timed',
      priorMode: 'guests',
      priorDuration: { type: 'minutes', endsAt: NOW_MS + (23 * 60_000) + 1 },
      expected: {
        nextValue: 7,
        controlMode: 'manual',
        manualSettingActiveTill: NOW_MS + (24 * 60_000),
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const configuration = structuredClone(fixture);
      configuration.deviceProperties[0].fireplaceModeStatus = 1;
      const { device, service } = createHarness({
        service: new AccountServiceDouble(configuration),
      });
      const session = {
        version: 1,
        priorMode: scenario.priorMode,
        priorDuration: scenario.priorDuration,
        selectedMinutes: 5,
        startedAt: NOW_MS,
        endsAt: NOW_MS + (5 * 60_000),
      };
      device.store.device_contract_version = 2;
      device.store.fireplace_session = session;
      await device.onInit();

      await device.capabilityListeners.get('button.stop_fireplace')();

      assert.equal(service.commands.length, 1);
      assert.equal(service.commands[0].command.nextParameter, 'requestedLevel');
      assert.equal(service.commands[0].command.nextValue, scenario.expected.nextValue);
      assert.equal(service.commands[0].command.controlMode, scenario.expected.controlMode);
      assert.equal(
        service.commands[0].command.manualSettingActiveTill,
        scenario.expected.manualSettingActiveTill,
      );
      assert.deepEqual(device.fireplaceSession, {
        ...session,
        suppressUntil: session.endsAt,
      });
      assert.deepEqual(device.store.fireplace_session, device.fireplaceSession);
      assert.equal(device.getCapabilityValue('vasco_fireplace'), false);
      assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
      assert.equal(device.clock.timers.size, 1);
    });
  }
});

test('Fireplace Stop suppression expires via its Homey timer without polling', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const service = new AccountServiceDouble(configuration);
  const { clock, device } = createHarness({ service });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();

  await device.capabilityListeners.get('button.stop_fireplace')();

  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].at, session.endsAt);
  clock.advance(5 * 60_000);
  await settle();

  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.equal(clock.timers.size, 0);
  assert.equal(service.reads.length, 2);
  assert.deepEqual(service.reads.at(-1), { force: true });
  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
});

test('Fireplace Stop suppression expiry releases local status when forced refresh fails', async () => {
  const secret = 'private-forced-refresh-response';
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const service = new AccountServiceDouble(configuration);
  const { clock, device } = createHarness({ service });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();

  await device.capabilityListeners.get('button.stop_fireplace')();
  await device.applyState({
    ...toDeviceState(configuration.deviceProperties[0]),
    fireplaceModeStatus: 1,
  });
  service.readConfiguration = async (options = {}) => {
    service.reads.push(options);
    throw new VascoTransportError(`${secret}: unavailable`);
  };

  clock.advance(5 * 60_000);
  await settle();

  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(service.reads.at(-1), { force: true });
  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
  assert.equal(device.logged.flat().join(' ').includes(secret), false);
});

test('Fireplace Stop suppression expiry recovers from local cleanup and write failures', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const service = new AccountServiceDouble(configuration);
  const { clock, device } = createHarness({ service });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();
  await device.capabilityListeners.get('button.stop_fireplace')();
  await device.applyState({
    ...toDeviceState(configuration.deviceProperties[0]),
    fireplaceModeStatus: 1,
  });

  let removalAttempts = 0;
  const unsetStoreValue = device.unsetStoreValue.bind(device);
  device.unsetStoreValue = async (key) => {
    removalAttempts += 1;
    if (removalAttempts === 1) throw new Error('private cleanup failure');
    return unsetStoreValue(key);
  };
  let activeWriteAttempts = 0;
  const setCapabilityValue = device.setCapabilityValue.bind(device);
  device.setCapabilityValue = async (capability, value) => {
    if (capability === 'vasco_fireplace' && value === true) {
      activeWriteAttempts += 1;
      if (activeWriteAttempts === 1) throw new Error('private capability failure');
    }
    return setCapabilityValue(capability, value);
  };

  clock.advance(5 * 60_000);
  await settle();

  assert.equal(removalAttempts, 2);
  assert.equal(activeWriteAttempts, 2);
  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.deepEqual(service.reads.at(-1), { force: true });
  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
  assert.equal(device.logged.flat().join(' ').includes('private'), false);
});

test('Fireplace Stop suppression expiry maps unknown raw status to null offline', async () => {
  const secret = 'private-offline-response';
  const service = new AccountServiceDouble();
  service.readConfiguration = async (options = {}) => {
    service.reads.push(options);
    throw new VascoTransportError(`${secret}: unavailable`);
  };
  const { clock, device } = createHarness({ service });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();
  const executeDeviceCommand = service.executeDeviceCommand.bind(service);
  service.executeDeviceCommand = async (...args) => {
    const state = await executeDeviceCommand(...args);
    delete state.fireplaceModeStatus;
    return state;
  };
  await device.capabilityListeners.get('button.stop_fireplace')();

  clock.advance(5 * 60_000);
  await settle();

  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
  assert.equal(device.getCapabilityValue('vasco_fireplace'), null);
  assert.deepEqual(service.reads.at(-1), { force: true });
  assert.equal(device.logged.flat().join(' ').includes(secret), false);
});

test('Fireplace Stop suppresses stale active status until the deadline then resumes raw status', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const { clock, device } = createHarness({
    service: new AccountServiceDouble(configuration),
  });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();

  await device.capabilityListeners.get('button.stop_fireplace')();
  await device.applyState({
    ...toDeviceState(configuration.deviceProperties[0]),
    fireplaceModeStatus: 1,
  });

  assert.equal(device.getCapabilityValue('vasco_fireplace'), false);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), true);

  clock.advance(5 * 60_000);
  await device.applyState({
    ...toDeviceState(configuration.deviceProperties[0]),
    fireplaceModeStatus: 1,
  });

  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
});

test('Fireplace Stop removes stale-status suppression as soon as raw status becomes inactive', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const { device } = createHarness({
    service: new AccountServiceDouble(configuration),
  });
  const session = {
    version: 1,
    priorMode: 'high',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();
  await device.capabilityListeners.get('button.stop_fireplace')();

  await device.applyState({
    ...toDeviceState(configuration.deviceProperties[0]),
    fireplaceModeStatus: 0,
  });

  assert.equal(device.getCapabilityValue('vasco_fireplace'), false);
  assert.equal(device.fireplaceSession, null);
  assert.equal(Object.hasOwn(device.store, 'fireplace_session'), false);
});

test('failed Fireplace Stop retains the managed session and countdown with a fixed error', async () => {
  const secret = 'private-stop-upstream-response';
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const service = new AccountServiceDouble(configuration);
  const { device } = createHarness({ service });
  const session = {
    version: 1,
    priorMode: 'auto',
    priorDuration: { type: 'permanent' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();
  service.executeDeviceCommand = async () => {
    throw new VascoProtocolError(`${secret}: stop rejected`);
  };

  await assert.rejects(
    () => device.capabilityListeners.get('button.stop_fireplace')(),
    (error) => {
      assert.equal(error.message, 'Vasco did not confirm the requested operating mode.');
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  assert.deepEqual(device.fireplaceSession, session);
  assert.deepEqual(device.store.fireplace_session, session);
  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), 5);
  assert.equal(device.clock.timers.size, 1);
  assert.equal(device.logged.flat().join(' ').includes(secret), false);
});

test('failed Fireplace Stop persistence leaves the active session and countdown coherent', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const { device } = createHarness({
    service: new AccountServiceDouble(configuration),
  });
  const session = {
    version: 1,
    priorMode: 'auto',
    priorDuration: { type: 'permanent' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };
  device.store.device_contract_version = 2;
  device.store.fireplace_session = session;
  await device.onInit();
  const setStoreValue = device.setStoreValue.bind(device);
  device.setStoreValue = async (key, value) => {
    if (key === 'fireplace_session' && Object.hasOwn(value, 'suppressUntil')) {
      throw new Error('private synthetic Stop store failure');
    }
    return setStoreValue(key, value);
  };

  await assert.rejects(
    () => device.capabilityListeners.get('button.stop_fireplace')(),
    { message: 'Homey could not save the stopped Fireplace session.' },
  );

  assert.deepEqual(device.fireplaceSession, session);
  assert.deepEqual(device.store.fireplace_session, session);
  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), 5);
  assert.equal(device.clock.timers.size, 1);
  assert.equal(
    device.logged.flat().join(' ').includes('private synthetic Stop store failure'),
    false,
  );
});

test('external Fireplace Stop returns a fixed explanation without sending any command', async () => {
  const configuration = structuredClone(fixture);
  configuration.deviceProperties[0].fireplaceModeStatus = 1;
  const { device, service } = createHarness({
    service: new AccountServiceDouble(configuration),
  });
  device.store.device_contract_version = 2;
  await device.onInit();

  await assert.rejects(
    () => device.capabilityListeners.get('button.stop_fireplace')(),
    {
      message: 'Homey can only stop Fireplace mode sessions that were started from Homey.',
    },
  );

  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
  assert.equal(device.getCapabilityValue('measure_fireplace_remaining'), null);
  assert.deepEqual(service.commands, []);
});

test('Fireplace Stop reports that an already-ended Homey session is no longer active', async () => {
  const { device, service } = createHarness();
  device.store.device_contract_version = 2;
  await device.onInit();

  await assert.rejects(
    () => device.capabilityListeners.get('button.stop_fireplace')(),
    {
      message: 'There is no active Homey-started Fireplace mode session to stop.',
    },
  );

  assert.equal(device.getCapabilityValue('vasco_fireplace'), false);
  assert.deepEqual(service.commands, []);
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

test('Homey onUninit releases polling and the shared account reference idempotently', async () => {
  const { device, registry, service } = createHarness();
  await device.onInit();

  await device.onUninit();
  await device.onDeleted();

  assert.equal(service.pollingStops, 1);
  assert.deepEqual(registry.releases, ['synthetic-account-key']);
  assert.equal(device.accountService, null);
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
