'use strict';

const Homey = require('homey');
const { VascoAccountRegistry } = require('./lib/vasco-account-registry');
const { VascoApiClient } = require('./lib/vasco-api-client');
const { VascoAuthenticationError } = require('./lib/vasco-errors');

module.exports = class VascoKermiXApp extends Homey.App {
  async onInit() {
    const clock = {
      now: () => Date.now(),
      setTimeout: (fn, delayMs) => this.homey.setTimeout(fn, delayMs),
      clearTimeout: timer => this.homey.clearTimeout(timer),
    };
    this.vascoAccountRegistry = new VascoAccountRegistry({
      apiClientFactory: () => new VascoApiClient({ clock }),
      clock,
      notify: error => this.homey.notifications.createNotification({
        excerpt: error instanceof VascoAuthenticationError
          ? 'Vasco authentication failed; update the account credentials.'
          : 'A Vasco account operation needs attention.',
      }),
    });
    this.registerFlowCards();
    this.log('Vasco/Kermi X Series app has been initialized');
  }

  async onUninit() {
    this.vascoAccountRegistry?.close();
    this.vascoAccountRegistry = null;
  }

  registerFlowCards() {
    if (this.flowCardsRegistered) return;
    this.flowCardsRegistered = true;
    const flow = this.homey.flow;
    const action = (id, listener) => flow.getActionCard(id).registerRunListener(listener);
    const condition = (id, listener) => flow.getConditionCard(id).registerRunListener(listener);

    action('set_mode_until_schedule', async ({ device, mode }) => (
      runMode(device, mode, { type: 'schedule' })
    ));
    action('set_mode_permanent', async ({ device, mode }) => (
      runMode(device, mode, { type: 'permanent' })
    ));
    action('set_mode_for_minutes', async ({ device, mode, minutes }) => (
      runMode(device, mode, { type: 'minutes', minutes: flowMinutes(minutes) })
    ));
    action('enable_fireplace_for_minutes', async ({ device, minutes }) => {
      await requiredDevice(device).setFireplace(true, flowMinutes(minutes));
      return true;
    });
    action('refresh_state', async ({ device }) => {
      await requiredDevice(device).refreshState({ force: true });
      return true;
    });

    condition('mode_is', ({ device, mode }) => (
      requiredDevice(device).getCapabilityValue('vasco_mode') === mode
    ));
    condition('fireplace_is_active', ({ device }) => (
      requiredDevice(device).getCapabilityValue('vasco_fireplace') === true
    ));
    condition('manual_override_is_active', ({ device }) => (
      requiredDevice(device).getCapabilityValue('vasco_control_state') === 'manual'
    ));
    condition('control_duration_is', ({ device, duration }) => {
      const value = requiredDevice(device).getCapabilityValue('vasco_control_duration');
      return value !== null && value !== undefined && value === duration;
    });
    condition('filter_attention', ({ device }) => (
      requiredDevice(device).getCapabilityValue('alarm_filter') === true
    ));
    condition('fault_present', ({ device }) => (
      requiredDevice(device).getCapabilityValue('alarm_generic') === true
    ));
    condition('defrost_active', ({ device }) => (
      requiredDevice(device).getCapabilityValue('alarm_defrost') === true
    ));

    this.vascoTriggerCards = new Map([
      'mode_changed',
      'fireplace_enabled',
      'fireplace_disabled',
      'filter_warning_appeared',
      'fault_appeared',
      'fault_cleared',
      'device_became_unavailable',
      'device_became_available',
    ].map(id => [id, flow.getDeviceTriggerCard(id)]));
  }

  async onVascoDeviceTransition(device, event, tokens = {}) {
    const trigger = this.vascoTriggerCards?.get(event);
    if (!trigger) return false;
    await trigger.trigger(requiredDevice(device), tokens, {});
    return true;
  }
};

async function runMode(device, mode, duration) {
  await requiredDevice(device).setOperatingMode(mode, duration);
  return true;
}

function requiredDevice(device) {
  if (!device || typeof device !== 'object') {
    throw new Error('Select a Vasco ventilation device.');
  }
  return device;
}

function flowMinutes(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new RangeError('Duration must be a whole number between 1 and 1440 minutes.');
  }
  return value;
}
