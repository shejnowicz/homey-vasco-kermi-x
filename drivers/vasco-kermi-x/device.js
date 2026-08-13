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
    this.accountService = this.accountRegistry.acquire({
      email: settings.vasco_email,
      password: settings.vasco_password,
    });
    this.stateInitialized = false;
    this.lastAvailability = null;

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

    subscribeToPolling(
      this.accountService,
      this,
      pollInterval(settings.poll_interval),
    );
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
    const device = discoverVentilationDevices(configuration)
      .find(candidate => candidate.identity === this.identity);
    if (!device) {
      throw new VascoProtocolError('The paired Vasco ventilation device was not found');
    }

    await this.applyState(toDeviceState(device.raw), { initial });
    this.stateInitialized = true;
  }

  async applyState(state, { initial = false } = {}) {
    if (state === null || typeof state !== 'object') {
      throw new TypeError('A mapped Vasco device state is required');
    }

    const changes = new Map();
    for (const [capability, mapValue] of CAPABILITIES) {
      const value = mapValue(state);
      if (value === null || value === undefined) continue;

      const previous = this.getCapabilityValue(capability);
      if (Object.is(previous, value)) continue;
      await this.setCapabilityValue(capability, value);
      changes.set(capability, { previous, value });
    }

    if (initial) return;
    await this.emitCapabilityTransitions(changes);
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
    if (this.lastAvailability === available) return;

    const previous = this.lastAvailability;
    this.lastAvailability = available;
    if (available) {
      await this.setAvailable();
    } else {
      await this.setUnavailable(availabilityMessage(error));
    }

    if (initial || previous === null) return;
    await this.emitTransition(
      available ? 'device_became_available' : 'device_became_unavailable',
    );
  }

  async onSettings({ newSettings, changedKeys = [] }) {
    validateChangedSettings(newSettings, changedKeys);

    if (changedKeys.includes('vasco_email') || changedKeys.includes('vasco_password')) {
      try {
        await this.accountService.updateCredentials(
          newSettings.vasco_email,
          newSettings.vasco_password,
        );
      } catch {
        throw new Error('Could not validate Vasco credentials. Settings were not changed.');
      }
    }

    if (changedKeys.includes('poll_interval')) {
      updatePollingSubscription(
        this.accountService,
        this,
        pollInterval(newSettings.poll_interval),
      );
    }
  }

  async onDeleted() {
    const service = this.accountService;
    const registry = this.accountRegistry;
    if (!service || !registry) return;

    unsubscribeFromPolling(service, this);
    this.accountService = null;
    this.accountRegistry = null;
    registry.release(service.accountKey);
  }
};

function subscribeToPolling(service, device, intervalSeconds) {
  let coordinator = POLLING_COORDINATORS.get(service);
  if (!coordinator) {
    coordinator = {
      intervalSeconds: null,
      subscribers: new Map(),
    };
    POLLING_COORDINATORS.set(service, coordinator);
  }

  coordinator.subscribers.set(device, intervalSeconds);
  reschedulePolling(service, coordinator);
}

function updatePollingSubscription(service, device, intervalSeconds) {
  const coordinator = POLLING_COORDINATORS.get(service);
  if (!coordinator || !coordinator.subscribers.has(device)) return;

  coordinator.subscribers.set(device, intervalSeconds);
  reschedulePolling(service, coordinator);
}

function unsubscribeFromPolling(service, device) {
  const coordinator = POLLING_COORDINATORS.get(service);
  if (!coordinator) return;

  const previousInterval = coordinator.intervalSeconds;
  coordinator.subscribers.delete(device);
  if (coordinator.subscribers.size === 0) {
    POLLING_COORDINATORS.delete(service);
    return;
  }
  if (minimumPollingInterval(coordinator) !== previousInterval) {
    reschedulePolling(service, coordinator);
  }
}

function reschedulePolling(service, coordinator) {
  const intervalSeconds = minimumPollingInterval(coordinator);
  if (intervalSeconds === coordinator.intervalSeconds) return;
  coordinator.intervalSeconds = intervalSeconds;

  service.startPolling(
    intervalSeconds,
    configuration => Promise.all([...coordinator.subscribers.keys()].map(device => (
      device.applyConfiguration(configuration, { initial: !device.stateInitialized })
    ))),
    (available, error) => Promise.all([...coordinator.subscribers.keys()].map(device => (
      device.handleAvailability(available, { error })
    ))),
  );
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
