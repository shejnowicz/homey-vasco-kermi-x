'use strict';

const Homey = require('homey');

const { VascoAccountRegistry } = require('../../lib/vasco-account-registry');
const { VascoApiClient } = require('../../lib/vasco-api-client');
const {
  buildFireplaceEnableCommand,
  buildModeCommand,
  isFireplaceConfirmed,
  isModeConfirmed,
} = require('../../lib/vasco-command-builder');
const {
  discoverVentilationDevices,
  toDeviceState,
} = require('../../lib/vasco-device-mapper');
const { VascoAuthenticationError, VascoProtocolError } = require('../../lib/vasco-errors');
const { MODES } = require('../../lib/vasco-modes');

const DEFAULT_POLL_INTERVAL = 60;
const DEFAULT_MODE_MINUTES = 60;
const DEFAULT_FIREPLACE_MINUTES = 5;
const SETTINGS_UNCHANGED_MESSAGE =
  'Could not validate Vasco credentials. Settings were not changed.';
const SETTINGS_RECOVERY_MESSAGE =
  'Vasco credential recovery was incomplete. Re-enter the account credentials on all affected devices.';
const POLL_INTERVALS = new Set([30, 60, 120, 300, 600]);
const DURATION_TYPES = new Set(['schedule', 'permanent', 'minutes']);
const MODE_BY_LEVEL = new Map(
  Object.entries(MODES).map(([mode, level]) => [level, mode]),
);
const POLLING_COORDINATORS = new WeakMap();

const CAPABILITIES = Object.freeze([
  ['vasco_mode', state => MODE_BY_LEVEL.get(state.requestedMode) ?? null],
  ['measure_temperature.indoor', state => state.indoorTemperature],
  ['measure_temperature.outdoor', state => state.outdoorTemperature],
  ['vasco_supply_fan', state => state.fanSpeedInlet],
  ['vasco_exhaust_fan', state => state.fanSpeedExhaust],
  ['vasco_bypass', state => state.bypassPosition],
  ['vasco_control_state', state => (
    state.controlMode === 'schedule' || state.controlMode === 'manual'
      ? state.controlMode
      : null
  )],
  ['vasco_override_end', state => overrideEndValue(state.manualSettingActiveTill)],
  ['vasco_fireplace', state => flagValue(state.fireplaceModeStatus)],
  ['alarm_filter', state => flagValue(state.filterDirty)],
  ['alarm_generic', state => flagValue(state.faultStatus)],
  ['alarm_defrost', state => flagValue(state.defrost)],
  ['alarm_rf', state => rfAlarmValue(state.rfCommunicationStatus)],
]);

module.exports = class VascoKermiXDevice extends Homey.Device {
  async onInit() {
    this.identity = this.getData()?.id;
    if (typeof this.identity !== 'string' || this.identity.length === 0) {
      throw new VascoProtocolError('The paired Vasco device identity is missing');
    }

    this.accountRegistry = this.getAccountRegistry();
    const settings = this.getSettings();
    const intervalSeconds = pollInterval(settings.poll_interval);
    this.accountService = null;
    this.stateInitialized = false;
    this.lastAvailability = null;
    this.stateQueue = Promise.resolve();
    this.deleted = false;

    try {
      this.accountService = this.accountRegistry.acquire({
        email: settings.vasco_email,
        password: settings.vasco_password,
      });

      this.registerCapabilityListener('vasco_mode', mode => (
        this.setOperatingMode(mode, defaultModeDuration(this.getSettings()))
      ));
      this.registerCapabilityListener('vasco_fireplace', enabled => (
        this.setFireplace(enabled, defaultFireplaceMinutes(this.getSettings()))
      ));
      this.registerCapabilityListener('button.test_connection', () => this.testConnection());

      try {
        await this.refreshState({ force: false, initial: true });
        await this.handleAvailability(true, { initial: true });
      } catch (error) {
        await this.handleAvailability(false, { error, initial: true });
      }

      subscribeToPolling(this.accountService, this, intervalSeconds);
    } catch (error) {
      await this.cleanupAccountReference();
      throw error;
    }
  }

  getAccountRegistry() {
    const app = this.homey?.app;
    if (!app) throw new Error('The Vasco app runtime is unavailable');
    if (app.vascoAccountRegistry) return app.vascoAccountRegistry;

    app.vascoAccountRegistry = new VascoAccountRegistry({
      apiClientFactory: () => new VascoApiClient(),
      notify: error => this.homey?.notifications?.createNotification({
        excerpt: error instanceof VascoAuthenticationError
          ? 'Vasco authentication failed; update the account credentials.'
          : 'A Vasco account operation needs attention.',
      }),
    });
    return app.vascoAccountRegistry;
  }

  getNow() {
    return Date.now();
  }

  async refreshState({ force = false, initial = !this.stateInitialized } = {}) {
    const configuration = await this.accountService.readConfiguration({ force });
    await this.applyConfiguration(configuration, { initial });
    return true;
  }

  async applyConfiguration(configuration, { initial = !this.stateInitialized } = {}) {
    if (this.deleted) return false;
    const device = discoverVentilationDevices(configuration)
      .find(candidate => candidate.identity === this.identity);
    if (!device) {
      throw new VascoProtocolError('The paired Vasco ventilation device was not found');
    }

    const state = toDeviceState(device.raw);
    return this.enqueueState(async () => {
      const applied = await this.applyStateNow(state, { initial });
      if (applied && !this.deleted) this.stateInitialized = true;
      return applied;
    });
  }

  async applyState(state, { initial = false } = {}) {
    if (state === null || typeof state !== 'object') {
      throw new TypeError('A mapped Vasco device state is required');
    }

    return this.enqueueState(() => this.applyStateNow(state, { initial }));
  }

  async applyStateNow(state, { initial = false } = {}) {
    if (this.deleted) return false;
    const changes = new Map();
    for (const [capability, mapValue] of CAPABILITIES) {
      if (this.deleted) return false;
      const value = mapValue(state);
      if (value === null || value === undefined) continue;

      const previous = this.getCapabilityValue(capability);
      if (Object.is(previous, value)) continue;
      await this.setCapabilityValue(capability, value);
      changes.set(capability, { previous, value });
    }

    if (initial || this.deleted) return !this.deleted;
    await this.emitCapabilityTransitions(changes);
    return !this.deleted;
  }

  enqueueState(operation) {
    const predecessor = this.stateQueue ?? Promise.resolve();
    const queued = predecessor
      .catch(() => undefined)
      .then(() => (this.deleted ? false : operation()));
    this.stateQueue = queued;
    return queued;
  }

  async emitCapabilityTransitions(changes) {
    const mode = changes.get('vasco_mode');
    if (mode && mode.previous !== null) {
      await this.emitTransition('mode_changed', {
        previous_mode: mode.previous,
        new_mode: mode.value,
      });
    }

    const fireplace = changes.get('vasco_fireplace');
    if (fireplace && fireplace.previous !== null) {
      await this.emitTransition(
        fireplace.value ? 'fireplace_enabled' : 'fireplace_disabled',
      );
    }

    const filter = changes.get('alarm_filter');
    if (filter?.previous === false && filter.value === true) {
      await this.emitTransition('filter_warning_appeared');
    }

    const fault = changes.get('alarm_generic');
    if (fault && fault.previous !== null) {
      await this.emitTransition(fault.value ? 'fault_appeared' : 'fault_cleared');
    }
  }

  async emitTransition(event, tokens = {}) {
    if (this.deleted) return;
    const transitionHook = this.homey?.app?.onVascoDeviceTransition;
    if (typeof transitionHook !== 'function') return;

    try {
      await transitionHook.call(this.homey.app, this, event, tokens);
    } catch {
      // Flow delivery must not interrupt device synchronization or expose payloads.
    }
  }

  async setOperatingMode(mode, duration) {
    const request = { mode, duration };
    if (duration?.type === 'minutes') request.nowMs = this.getNow();

    try {
      const state = await this.accountService.executeDeviceCommand(
        this.identity,
        raw => buildModeCommand(raw, request),
        observed => isModeConfirmed(observed, request),
      );
      await this.applyState(state, { initial: false });
      return true;
    } catch {
      await this.restoreObservedState();
      throw new Error('Vasco did not confirm the requested operating mode.');
    }
  }

  async setFireplace(enabled, minutes) {
    if (enabled !== true) {
      throw new Error('Disabling Fireplace mode is not supported yet.');
    }

    try {
      const state = await this.accountService.executeDeviceCommand(
        this.identity,
        raw => buildFireplaceEnableCommand(raw, { minutes }),
        observed => isFireplaceConfirmed(observed, true),
      );
      await this.applyState(state, { initial: false });
      return true;
    } catch {
      await this.restoreObservedState();
      throw new Error('Vasco did not confirm Fireplace mode.');
    }
  }

  async restoreObservedState() {
    try {
      await this.refreshState({ force: true, initial: false });
    } catch {
      // Preserve the fixed command error when rollback itself cannot be read.
    }
  }

  async testConnection() {
    try {
      await this.refreshState({ force: true, initial: !this.stateInitialized });
      await this.handleAvailability(true);
      return true;
    } catch (error) {
      await this.handleAvailability(false, { error });
      throw new Error('Could not connect to Vasco. Check the saved credentials and try again.');
    }
  }

  async handleAvailability(available, { error, initial = false } = {}) {
    return this.enqueueState(() => this.handleAvailabilityNow(available, { error, initial }));
  }

  async handleAvailabilityNow(available, { error, initial = false } = {}) {
    if (this.lastAvailability === available) return;

    const previous = this.lastAvailability;
    if (available) {
      await this.setAvailable();
    } else {
      await this.setUnavailable(availabilityMessage(error));
    }
    if (this.deleted) return;
    this.lastAvailability = available;

    if (initial || previous === null) return;
    await this.emitTransition(
      available ? 'device_became_available' : 'device_became_unavailable',
    );
  }

  async onSettings({ newSettings, changedKeys = [] }) {
    validateChangedSettings(newSettings, changedKeys);
    const service = this.accountService;
    if (!service || this.deleted) {
      throw new Error('The Vasco device is no longer available.');
    }

    return queueAccountSettings(service, this, async (coordinator) => {
      const credentialsChanged = changedKeys.includes('vasco_email')
        || changedKeys.includes('vasco_password');
      let credentialTransaction = null;

      if (credentialsChanged) {
        credentialTransaction = await replaceSharedCredentials({
          service,
          coordinator,
          editor: this,
          newSettings,
        });
      }

      try {
        if (changedKeys.includes('poll_interval')) {
          updatePollingSubscription(
            service,
            this,
            pollInterval(newSettings.poll_interval),
            { force: credentialsChanged },
          );
        } else if (credentialsChanged) {
          reschedulePolling(service, coordinator, { force: true });
        }
      } catch {
        if (credentialTransaction) await credentialTransaction.rollback();
        throw new Error('Could not update Vasco settings. Settings were not changed.');
      }
      if (credentialTransaction) credentialTransaction.discard();
    });
  }

  async onDeleted() {
    const service = this.accountService;
    const registry = this.accountRegistry;
    if (!service || !registry) return;

    this.deleted = true;
    const coordinator = POLLING_COORDINATORS.get(service);
    unsubscribeFromPolling(service, this);
    this.accountService = null;
    this.accountRegistry = null;
    if (coordinator?.settingsChain) {
      try {
        await coordinator.settingsChain;
      } catch {
        // A rejected settings update must not prevent account cleanup.
      }
    }
    registry.release(service.accountKey);
  }

  async cleanupAccountReference() {
    const service = this.accountService;
    const registry = this.accountRegistry;
    this.deleted = true;
    if (!service || !registry) return;

    unsubscribeFromPolling(service, this);
    this.accountService = null;
    this.accountRegistry = null;
    try {
      registry.release(service.accountKey);
    } catch {
      // Preserve the initialization error while still severing local references.
    }
  }
};

function subscribeToPolling(service, device, intervalSeconds) {
  let coordinator = POLLING_COORDINATORS.get(service);
  if (!coordinator) {
    coordinator = {
      intervalSeconds: null,
      subscribers: new Map(),
      settingsChain: Promise.resolve(),
      recoveryRequired: false,
    };
    POLLING_COORDINATORS.set(service, coordinator);
  }

  coordinator.subscribers.set(device, intervalSeconds);
  reschedulePolling(service, coordinator);
}

function updatePollingSubscription(service, device, intervalSeconds, { force = false } = {}) {
  const coordinator = POLLING_COORDINATORS.get(service);
  if (!coordinator || !coordinator.subscribers.has(device)) return;

  coordinator.subscribers.set(device, intervalSeconds);
  reschedulePolling(service, coordinator, { force });
}

function unsubscribeFromPolling(service, device) {
  const coordinator = POLLING_COORDINATORS.get(service);
  if (!coordinator) return;

  const previousInterval = coordinator.intervalSeconds;
  coordinator.subscribers.delete(device);
  if (coordinator.subscribers.size === 0) {
    POLLING_COORDINATORS.delete(service);
    service.stopPolling();
    return;
  }
  if (minimumPollingInterval(coordinator) !== previousInterval) {
    reschedulePolling(service, coordinator);
  }
}

function reschedulePolling(service, coordinator, { force = false } = {}) {
  if (coordinator.subscribers.size === 0 || coordinator.recoveryRequired) return;
  const intervalSeconds = minimumPollingInterval(coordinator);
  if (!force && intervalSeconds === coordinator.intervalSeconds) return;
  coordinator.intervalSeconds = intervalSeconds;

  service.startPolling(
    intervalSeconds,
    configuration => Promise.all([...coordinator.subscribers.keys()].map(device => (
      applyPolledConfiguration(device, configuration)
    ))),
    (available, error) => {
      if (available) return Promise.resolve();
      return Promise.all([...coordinator.subscribers.keys()].map(device => (
        device.handleAvailability(false, { error })
      )));
    },
  );
}

async function applyPolledConfiguration(device, configuration) {
  if (device.deleted) return;
  try {
    const applied = await device.applyConfiguration(
      configuration,
      { initial: !device.stateInitialized },
    );
    if (applied) await device.handleAvailability(true);
  } catch (error) {
    if (!device.deleted) await device.handleAvailability(false, { error });
  }
}

function queueAccountSettings(service, device, operation) {
  const coordinator = POLLING_COORDINATORS.get(service);
  if (!coordinator || !coordinator.subscribers.has(device)) {
    return Promise.reject(new Error('The Vasco device is no longer available.'));
  }

  const update = coordinator.settingsChain
    .catch(() => undefined)
    .then(() => {
      if (device.deleted || !coordinator.subscribers.has(device)) {
        throw new Error('The Vasco device is no longer available.');
      }
      return operation(coordinator);
    });
  coordinator.settingsChain = update;
  return update;
}

async function replaceSharedCredentials({
  service,
  coordinator,
  editor,
  newSettings,
}) {
  const previousRecoveryRequired = coordinator.recoveryRequired;
  const nextCredentials = {
    vasco_email: newSettings.vasco_email,
    vasco_password: newSettings.vasco_password,
  };
  const updatedDevices = [];
  let credentialsReplaced = false;
  let credentialRollback = null;

  try {
    credentialRollback = await service.updateCredentials(
      nextCredentials.vasco_email,
      nextCredentials.vasco_password,
    );
    credentialsReplaced = true;
    service.stopPolling();
    for (const device of coordinator.subscribers.keys()) {
      if (device === editor || device.deleted) continue;
      const settings = device.getSettings();
      const before = {
        vasco_email: settings.vasco_email,
        vasco_password: settings.vasco_password,
      };
      await device.setSettings(nextCredentials);
      updatedDevices.push({ device, before });
    }
    coordinator.recoveryRequired = false;
  } catch {
    if (credentialsReplaced) {
      await rollbackAndResumePolling(
        service,
        coordinator,
        credentialRollback,
        updatedDevices,
        previousRecoveryRequired,
      );
    }
    throw new Error(SETTINGS_UNCHANGED_MESSAGE);
  }

  return {
    rollback: () => rollbackAndResumePolling(
      service,
      coordinator,
      credentialRollback,
      updatedDevices,
      previousRecoveryRequired,
    ),
    discard: () => credentialRollback.discard(),
  };
}

async function rollbackAndResumePolling(
  service,
  coordinator,
  credentialRollback,
  updatedDevices,
  previousRecoveryRequired,
) {
  const restored = await rollbackSharedCredentials(
    credentialRollback,
    updatedDevices,
  );
  if (!restored) {
    await stopForCredentialRecovery(service, coordinator);
    throw new Error(SETTINGS_RECOVERY_MESSAGE);
  }
  coordinator.recoveryRequired = previousRecoveryRequired;
  if (previousRecoveryRequired) {
    await stopForCredentialRecovery(service, coordinator);
    throw new Error(SETTINGS_RECOVERY_MESSAGE);
  }

  try {
    reschedulePolling(service, coordinator, { force: true });
  } catch {
    await stopForCredentialRecovery(service, coordinator);
    throw new Error(SETTINGS_RECOVERY_MESSAGE);
  }
}

async function rollbackSharedCredentials(
  credentialRollback,
  updatedDevices,
) {
  let settingsRestored = true;
  for (const { device, before } of [...updatedDevices].reverse()) {
    if (device.deleted) continue;
    try {
      await device.setSettings(before);
    } catch {
      settingsRestored = false;
    }
  }

  let serviceRestored = false;
  try {
    await credentialRollback.rollback();
    serviceRestored = true;
  } catch {
    // The caller stops polling and surfaces a fixed recovery error.
  }
  return settingsRestored && serviceRestored;
}

async function stopForCredentialRecovery(service, coordinator) {
  coordinator.recoveryRequired = true;
  service.stopPolling();
  const error = new VascoAuthenticationError(
    'Vasco credentials require recovery',
  );
  await Promise.all([...coordinator.subscribers.keys()].map(async (device) => {
    if (device.deleted) return;
    try {
      await device.handleAvailability(false, { error });
    } catch {
      // Continue marking the other affected devices before surfacing recovery.
    }
  }));
}

function minimumPollingInterval(coordinator) {
  return Math.min(...coordinator.subscribers.values());
}

function defaultModeDuration(settings) {
  const type = settings.default_duration_type ?? 'schedule';
  if (type === 'minutes') {
    return {
      type,
      minutes: validatedMinutes(
        settings.default_duration_minutes ?? DEFAULT_MODE_MINUTES,
        'Default mode duration',
      ),
    };
  }
  if (type !== 'schedule' && type !== 'permanent') {
    throw new RangeError('Default mode duration type is unsupported');
  }
  return { type };
}

function defaultFireplaceMinutes(settings) {
  return validatedMinutes(
    settings.default_fireplace_minutes ?? DEFAULT_FIREPLACE_MINUTES,
    'Default Fireplace duration',
  );
}

function validateChangedSettings(settings, changedKeys) {
  if (settings === null || typeof settings !== 'object') {
    throw new TypeError('Updated Vasco settings are required');
  }
  if (!Array.isArray(changedKeys)) {
    throw new TypeError('Changed Vasco setting keys must be an array');
  }

  if (changedKeys.includes('poll_interval')) pollInterval(settings.poll_interval);
  if (changedKeys.includes('default_duration_type')) {
    if (!DURATION_TYPES.has(settings.default_duration_type)) {
      throw new RangeError('Default mode duration type is unsupported');
    }
  }
  if (changedKeys.includes('default_duration_minutes')
    || (settings.default_duration_type === 'minutes'
      && changedKeys.includes('default_duration_type'))) {
    validatedMinutes(settings.default_duration_minutes, 'Default mode duration');
  }
  if (changedKeys.includes('default_fireplace_minutes')) {
    validatedMinutes(settings.default_fireplace_minutes, 'Default Fireplace duration');
  }
  if (changedKeys.includes('vasco_email') || changedKeys.includes('vasco_password')) {
    if (typeof settings.vasco_email !== 'string' || settings.vasco_email.trim().length === 0
      || typeof settings.vasco_password !== 'string' || settings.vasco_password.length === 0) {
      throw new TypeError('Vasco account credentials are required');
    }
  }
}

function pollInterval(value = String(DEFAULT_POLL_INTERVAL)) {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!POLL_INTERVALS.has(seconds) || String(seconds) !== String(value)) {
    throw new RangeError('Polling interval must be one of the supported presets');
  }
  return seconds;
}

function validatedMinutes(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new RangeError(`${label} must be a whole number from 1 to 1440 minutes`);
  }
  return value;
}

function flagValue(value) {
  return value === null || value === undefined ? null : value !== 0;
}

function rfAlarmValue(value) {
  return value === null || value === undefined ? null : value !== 1;
}

function overrideEndValue(value) {
  if (value === null || value === undefined) return null;
  if (value === 0) return 'schedule';
  if (value === -1) return 'permanent';
  if (!Number.isFinite(value)) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function availabilityMessage(error) {
  if (error instanceof VascoAuthenticationError) {
    return 'Vasco authentication failed. Update the account credentials.';
  }
  return 'The Vasco cloud service is temporarily unavailable.';
}
