'use strict';

const Homey = require('homey');

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
const {
  createManagedSession,
  effectiveFireplaceState,
  parseStoredSession,
  remainingMinutes,
  restorationRequest,
  stoppedSession,
} = require('../../lib/vasco-fireplace-session');
const { MODES } = require('../../lib/vasco-modes');

const DEFAULT_POLL_INTERVAL = 60;
const DEFAULT_MODE_MINUTES = 60;
const DEFAULT_FIREPLACE_MINUTES = 5;
const FIREPLACE_SESSION_STORE_KEY = 'fireplace_session';
const MINUTE_MS = 60_000;
const DEVICE_CONTRACT_VERSION = 2;
const DEVICE_CONTRACT_CAPABILITIES = [
  'button.enable_fireplace',
  'measure_vasco_mode',
  'vasco_fireplace_duration',
  'measure_fireplace_remaining',
  'button.stop_fireplace',
];
const SETTINGS_UNCHANGED_MESSAGE =
  'Could not validate Vasco credentials. Settings were not changed.';
const SETTINGS_RECOVERY_MESSAGE =
  'Vasco credential recovery was incomplete. Re-enter the account credentials on all affected devices.';
const POLL_INTERVALS = new Set([30, 60, 120, 300, 600]);
const DURATION_TYPES = new Set(['schedule', 'permanent', 'minutes']);
const MODE_BY_LEVEL = new Map(
  Object.entries(MODES).map(([mode, level]) => [level, mode]),
);
const POLLING_COORDINATOR = Symbol('vascoPollingCoordinator');

const CAPABILITIES = Object.freeze([
  ['vasco_mode', state => MODE_BY_LEVEL.get(state.requestedMode) ?? null],
  ['measure_vasco_mode', state => (
    MODE_BY_LEVEL.has(state.requestedMode) ? state.requestedMode : null
  )],
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
    await this.ensureDeviceContract();
    const settings = this.getSettings();
    const intervalSeconds = pollInterval(settings.poll_interval);
    this.accountService = null;
    this.stateInitialized = false;
    this.lastObservedState = null;
    this.lastAvailability = null;
    this.stateQueue = Promise.resolve();
    this.deleted = false;
    this.fireplaceTimer = null;
    const storedFireplaceSession = this.getStoreValue(FIREPLACE_SESSION_STORE_KEY);
    this.fireplaceSession = parseStoredSession(storedFireplaceSession, this.getNow());
    if (storedFireplaceSession !== null && storedFireplaceSession !== undefined
      && this.fireplaceSession === null) {
      await this.unsetStoreValue(FIREPLACE_SESSION_STORE_KEY);
    }

    try {
      this.accountService = this.accountRegistry.acquire({
        email: settings.vasco_email,
        password: settings.vasco_password,
      });

      this.registerCapabilityListener('vasco_mode', mode => (
        this.setOperatingMode(mode, defaultModeDuration(this.getSettings()))
      ));
      this.registerCapabilityListener('button.enable_fireplace', () => (
        this.setFireplace(true, defaultFireplaceMinutes(
          this.getCapabilityValue('vasco_fireplace_duration'),
        ))
      ));
      this.registerCapabilityListener('vasco_fireplace_duration', (value) => {
        fireplaceDurationMinutes(value);
        return true;
      });
      this.registerCapabilityListener('button.stop_fireplace', () => this.stopFireplace());
      this.registerCapabilityListener('button.test_connection', () => this.testConnection());
      await this.restoreFireplaceSession();

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

  async ensureDeviceContract() {
    for (const capability of DEVICE_CONTRACT_CAPABILITIES) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }

    const version = this.getStoreValue('device_contract_version') ?? 0;
    if (version >= DEVICE_CONTRACT_VERSION) return;
    if (version < 1 && this.getSettings().default_duration_type === 'permanent') {
      await this.setSettings({ default_duration_type: 'schedule' });
    }
    if (version < 2) {
      await this.setCapabilityValue(
        'vasco_fireplace_duration',
        fireplaceDurationValue(this.getSettings().default_fireplace_minutes),
      );
    }
    await this.setStoreValue('device_contract_version', DEVICE_CONTRACT_VERSION);
  }

  getAccountRegistry() {
    const app = this.homey?.app;
    if (!app) throw new Error('The Vasco app runtime is unavailable');
    if (app.vascoAccountRegistry) return app.vascoAccountRegistry;
    throw new Error('The Vasco account registry is not initialized');
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
    const fireplace = Object.hasOwn(state, 'fireplaceModeStatus')
      ? await this.reconcileFireplaceStateNow(state.fireplaceModeStatus)
      : null;
    for (const [capability, mapValue] of CAPABILITIES) {
      if (this.deleted) return false;
      const value = capability === 'vasco_fireplace' && fireplace
        ? fireplace.active
        : mapValue(state);
      if (value === null || value === undefined) continue;

      const previous = this.getCapabilityValue(capability);
      if (Object.is(previous, value)) continue;
      await this.setCapabilityValue(capability, value);
      changes.set(capability, { previous, value });
    }

    if (fireplace && !Object.is(
      this.getCapabilityValue('measure_fireplace_remaining'),
      fireplace.remaining,
    )) {
      await this.setCapabilityValue('measure_fireplace_remaining', fireplace.remaining);
    }

    this.rememberObservedState(state);
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

  async restoreFireplaceSession() {
    return this.enqueueState(async () => {
      if (!this.fireplaceSession) return false;

      if (Object.hasOwn(this.fireplaceSession, 'suppressUntil')) {
        if (this.getCapabilityValue('measure_fireplace_remaining') !== null) {
          await this.setCapabilityValue('measure_fireplace_remaining', null);
        }
        this.scheduleFireplaceSuppression();
        return true;
      }

      const remaining = remainingMinutes(this.fireplaceSession, this.getNow());
      if (!Object.is(
        this.getCapabilityValue('measure_fireplace_remaining'),
        remaining,
      )) {
        await this.setCapabilityValue('measure_fireplace_remaining', remaining);
      }
      if (this.deleted) return false;
      this.scheduleFireplaceCountdown(remaining);
      return true;
    });
  }

  async reconcileFireplaceStateNow(rawStatus) {
    const rawActive = flagValue(rawStatus);
    const nowMs = this.getNow();
    const stopped = this.fireplaceSession
      && Object.hasOwn(this.fireplaceSession, 'suppressUntil');
    if (this.fireplaceSession && (
      (stopped && (rawActive === false || nowMs >= this.fireplaceSession.suppressUntil))
      || (!stopped && nowMs >= this.fireplaceSession.endsAt)
    )) {
      this.clearFireplaceTimer();
      this.fireplaceSession = null;
      await this.unsetStoreValue(FIREPLACE_SESSION_STORE_KEY);
    }

    const active = effectiveFireplaceState(rawActive, this.fireplaceSession, nowMs);
    if (this.fireplaceSession
      && Object.hasOwn(this.fireplaceSession, 'suppressUntil')) {
      this.scheduleFireplaceSuppression(nowMs);
      return { active, remaining: null };
    }
    if (active === true && this.fireplaceSession
      && !Object.hasOwn(this.fireplaceSession, 'suppressUntil')) {
      const remaining = remainingMinutes(this.fireplaceSession, nowMs);
      this.scheduleFireplaceCountdown(remaining, nowMs);
      return { active, remaining };
    }

    this.clearFireplaceTimer();
    return { active, remaining: null };
  }

  rememberObservedState(state) {
    const observed = { ...(this.lastObservedState ?? {}) };
    for (const [key, value] of Object.entries(state)) {
      if (value !== null && value !== undefined) observed[key] = value;
    }
    this.lastObservedState = observed;
  }

  scheduleFireplaceCountdown(remaining, nowMs = this.getNow()) {
    this.clearFireplaceTimer();
    if (!this.fireplaceSession || remaining < 1 || this.deleted) return;

    const nextBoundary = this.fireplaceSession.endsAt - ((remaining - 1) * MINUTE_MS);
    const delayMs = Math.max(1, nextBoundary - nowMs);
    this.setFireplaceTimer(delayMs);
  }

  scheduleFireplaceSuppression(nowMs = this.getNow()) {
    this.clearFireplaceTimer();
    if (!this.fireplaceSession
      || !Object.hasOwn(this.fireplaceSession, 'suppressUntil')
      || this.deleted) return;

    const delayMs = Math.max(1, this.fireplaceSession.suppressUntil - nowMs);
    this.setFireplaceTimer(delayMs);
  }

  setFireplaceTimer(delayMs) {
    this.fireplaceTimer = this.homey.setTimeout(() => {
      this.fireplaceTimer = null;
      this.handleFireplaceCountdown().catch((error) => {
        this.error('Vasco Fireplace countdown failed', diagnosticError(error));
      });
    }, delayMs);
  }

  async handleFireplaceCountdown() {
    const expired = await this.enqueueState(async () => {
      if (!this.fireplaceSession) return false;

      if (Object.hasOwn(this.fireplaceSession, 'suppressUntil')) {
        if (this.getNow() < this.fireplaceSession.suppressUntil) {
          this.scheduleFireplaceSuppression();
          return false;
        }
        await this.unsetStoreValue(FIREPLACE_SESSION_STORE_KEY);
        if (this.deleted) return false;
        this.fireplaceSession = null;
        return true;
      }

      const remaining = remainingMinutes(this.fireplaceSession, this.getNow());
      if (!Object.is(this.getCapabilityValue('measure_fireplace_remaining'), remaining)) {
        await this.setCapabilityValue('measure_fireplace_remaining', remaining);
      }
      if (this.deleted) return false;
      if (remaining > 0) {
        this.scheduleFireplaceCountdown(remaining);
        return false;
      }

      this.fireplaceSession = null;
      await this.unsetStoreValue(FIREPLACE_SESSION_STORE_KEY);
      return true;
    });

    if (!expired || this.deleted) return;
    await this.refreshState({ force: true, initial: false });
  }

  clearFireplaceTimer() {
    if (this.fireplaceTimer === null || this.fireplaceTimer === undefined) return;
    this.homey.clearTimeout(this.fireplaceTimer);
    this.fireplaceTimer = null;
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
        (raw) => {
          const command = buildModeCommand(raw, request);
          this.log('Vasco mode command shape', {
            keys: Object.keys(command).sort(),
            payloadLength: JSON.stringify([command]).length,
            level: command.level,
            requestedLevel: command.requestedLevel,
            nextParameter: command.nextParameter,
            nextValue: command.nextValue,
            controlMode: command.controlMode,
            manualSettingActiveTill: command.manualSettingActiveTill,
            remainingTimeTemporaryOverride: command.remainingTimeTemporaryOverride,
          });
          return command;
        },
        (observed) => {
          const confirmed = isModeConfirmed(observed, request);
          if (!confirmed) {
            this.log('Vasco mode confirmation pending', {
              requestedMode: observed.requestedMode,
              effectiveMode: observed.mode,
              controlMode: observed.controlMode,
              manualSettingActiveTill: observed.manualSettingActiveTill,
            });
          }
          return confirmed;
        },
      );
      await this.applyState(state, { initial: false });
      return true;
    } catch (error) {
      this.error('Vasco mode command failed', diagnosticError(error));
      await this.restoreObservedState();
      throw new Error('Vasco did not confirm the requested operating mode.');
    }
  }

  async setFireplace(enabled, minutes) {
    if (enabled !== true) {
      throw new Error('Disabling Fireplace mode is not supported yet.');
    }
    const commandMinutes = validatedMinutes(minutes, 'Fireplace duration');

    let rollback = null;
    try {
      await this.enqueueState(async () => {
        const previous = {
          active: this.getCapabilityValue('vasco_fireplace'),
          remaining: this.getCapabilityValue('measure_fireplace_remaining'),
          session: this.fireplaceSession,
          stored: this.getStoreValue(FIREPLACE_SESSION_STORE_KEY),
        };
        const session = createManagedSession(
          this.lastObservedState,
          commandMinutes,
          this.getNow(),
        );
        rollback = { previous, session };
        this.fireplaceSession = session;
        await this.setStoreValue(FIREPLACE_SESSION_STORE_KEY, session);
      });
      const state = await this.accountService.executeDeviceCommand(
        this.identity,
        raw => buildFireplaceEnableCommand(raw, { minutes: commandMinutes }),
        observed => isFireplaceConfirmed(observed, true),
      );
      await this.applyState(state, { initial: false });
      return true;
    } catch (error) {
      this.error('Vasco Fireplace command failed', diagnosticError(error));
      if (rollback) {
        await this.enqueueState(async () => {
          if (this.fireplaceSession !== rollback.session) return;

          this.clearFireplaceTimer();
          this.fireplaceSession = rollback.previous.session;
          if (rollback.previous.stored === null || rollback.previous.stored === undefined) {
            await this.unsetStoreValue(FIREPLACE_SESSION_STORE_KEY);
          } else {
            await this.setStoreValue(
              FIREPLACE_SESSION_STORE_KEY,
              rollback.previous.stored,
            );
          }
          if (!Object.is(
            this.getCapabilityValue('vasco_fireplace'),
            rollback.previous.active,
          )) {
            await this.setCapabilityValue('vasco_fireplace', rollback.previous.active);
          }
          if (!Object.is(
            this.getCapabilityValue('measure_fireplace_remaining'),
            rollback.previous.remaining,
          )) {
            await this.setCapabilityValue(
              'measure_fireplace_remaining',
              rollback.previous.remaining,
            );
          }
          if (rollback.previous.session && rollback.previous.active === true
            && !Object.hasOwn(rollback.previous.session, 'suppressUntil')) {
            this.scheduleFireplaceCountdown(
              remainingMinutes(rollback.previous.session, this.getNow()),
            );
          }
        });
      }
      await this.restoreObservedState();
      throw new Error('Vasco did not confirm Fireplace mode.');
    }
  }

  async stopFireplace() {
    const session = this.fireplaceSession;
    if (!session || Object.hasOwn(session, 'suppressUntil')) {
      throw new Error(
        'Homey can only stop Fireplace mode sessions that were started from Homey.',
      );
    }

    const request = restorationRequest(session, this.getNow());
    if (!request) {
      throw new Error(
        'Homey can only stop Fireplace mode sessions that were started from Homey.',
      );
    }

    const previous = {
      active: this.getCapabilityValue('vasco_fireplace'),
      remaining: this.getCapabilityValue('measure_fireplace_remaining'),
      timerActive: this.fireplaceTimer !== null && this.fireplaceTimer !== undefined,
    };
    await this.setOperatingMode(request.mode, request.duration);
    const stopped = stoppedSession(session);
    let persisted = false;
    try {
      await this.enqueueState(async () => {
        if (this.fireplaceSession !== session) return false;

        await this.setStoreValue(FIREPLACE_SESSION_STORE_KEY, stopped);
        persisted = true;
        if (this.deleted) return false;
        this.fireplaceSession = stopped;
        this.scheduleFireplaceSuppression();

        const changes = new Map();
        const previousActive = this.getCapabilityValue('vasco_fireplace');
        if (previousActive !== false) {
          await this.setCapabilityValue('vasco_fireplace', false);
          changes.set('vasco_fireplace', { previous: previousActive, value: false });
        }
        if (this.getCapabilityValue('measure_fireplace_remaining') !== null) {
          await this.setCapabilityValue('measure_fireplace_remaining', null);
        }
        if (!this.deleted) await this.emitCapabilityTransitions(changes);
        return true;
      });
    } catch (error) {
      this.error('Vasco Fireplace Stop persistence failed', diagnosticError(error));
      if (!persisted) {
        await this.enqueueState(async () => {
          if (this.fireplaceSession !== session) return false;

          if (!Object.is(this.getCapabilityValue('vasco_fireplace'), previous.active)) {
            await this.setCapabilityValue('vasco_fireplace', previous.active);
          }
          if (!Object.is(
            this.getCapabilityValue('measure_fireplace_remaining'),
            previous.remaining,
          )) {
            await this.setCapabilityValue(
              'measure_fireplace_remaining',
              previous.remaining,
            );
          }
          if (previous.timerActive && previous.active === true) {
            this.scheduleFireplaceCountdown(
              remainingMinutes(session, this.getNow()),
            );
          }
          return true;
        });
        throw new Error('Homey could not save the stopped Fireplace session.');
      }
      throw new Error('Homey could not update the stopped Fireplace session.');
    }
    return true;
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
    this.clearFireplaceTimer();
    this.deleted = true;
    const service = this.accountService;
    const registry = this.accountRegistry;
    if (!service || !registry) return;

    const coordinator = getPollingCoordinator(service);
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

  async onUninit() {
    await this.cleanupAccountReference();
  }

  async cleanupAccountReference() {
    const service = this.accountService;
    const registry = this.accountRegistry;
    this.clearFireplaceTimer();
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
  let coordinator = getPollingCoordinator(service);
  if (!coordinator) {
    coordinator = {
      intervalSeconds: null,
      subscribers: new Map(),
      settingsChain: Promise.resolve(),
      recoveryRequired: false,
    };
    Object.defineProperty(service, POLLING_COORDINATOR, {
      value: coordinator,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  coordinator.subscribers.set(device, intervalSeconds);
  reschedulePolling(service, coordinator);
}

function updatePollingSubscription(service, device, intervalSeconds, { force = false } = {}) {
  const coordinator = getPollingCoordinator(service);
  if (!coordinator || !coordinator.subscribers.has(device)) return;

  coordinator.subscribers.set(device, intervalSeconds);
  reschedulePolling(service, coordinator, { force });
}

function unsubscribeFromPolling(service, device) {
  const coordinator = getPollingCoordinator(service);
  if (!coordinator) return;

  const previousInterval = coordinator.intervalSeconds;
  coordinator.subscribers.delete(device);
  if (coordinator.subscribers.size === 0) {
    delete service[POLLING_COORDINATOR];
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
  const coordinator = getPollingCoordinator(service);
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

function getPollingCoordinator(service) {
  return service?.[POLLING_COORDINATOR] ?? null;
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

function defaultFireplaceMinutes(value) {
  return fireplaceDurationMinutes(value);
}

function fireplaceDurationValue(legacyValue) {
  const minutes = Number(legacyValue);
  if (!Number.isFinite(minutes)) return String(DEFAULT_FIREPLACE_MINUTES);
  return String(Math.round(Math.min(85, Math.max(5, minutes)) / 5) * 5);
}

function fireplaceDurationMinutes(value) {
  const minutes = Number(value ?? DEFAULT_FIREPLACE_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 85 || minutes % 5 !== 0) {
    throw new RangeError('Fireplace duration must be a supported five-minute value from 5 to 85');
  }
  return minutes;
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
  if (changedKeys.includes('vasco_fireplace_duration')) {
    fireplaceDurationMinutes(settings.vasco_fireplace_duration);
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
  return value === null || value === undefined ? null : value !== 0;
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

function diagnosticError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: 'Vasco operation failed',
  };
}
