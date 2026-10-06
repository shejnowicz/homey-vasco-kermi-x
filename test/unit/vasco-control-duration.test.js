'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { controlDurationValue, controlStateValue } = require('../../lib/vasco-control-duration');

const NOW_MS = 1_700_000_000_000;

test('maps zero, permanent, and future timed Vasco control deadlines', () => {
  assert.equal(controlDurationValue({
    controlMode: 'schedule', manualSettingActiveTill: 0,
  }, NOW_MS), 'until_schedule');
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: 0,
  }, NOW_MS), 'until_schedule');
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: -1,
  }, NOW_MS), 'permanent');
  assert.equal(controlDurationValue({
    controlMode: 'schedule', manualSettingActiveTill: -1,
  }, NOW_MS), 'permanent');
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: NOW_MS + 1,
  }, NOW_MS), 'timed');
  assert.equal(controlDurationValue({
    controlMode: 'schedule', manualSettingActiveTill: NOW_MS + 1,
  }, NOW_MS), 'timed');
});

test('maps an expired timed override back to until schedule', () => {
  assert.equal(controlDurationValue({
    controlMode: 'schedule', manualSettingActiveTill: NOW_MS,
  }, NOW_MS), 'until_schedule');
});

test('returns null for an unknown control state', () => {
  assert.equal(controlDurationValue({}, NOW_MS), null);
});

test('returns null when the state or clock is malformed', () => {
  assert.equal(controlDurationValue(null, NOW_MS), null);
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: NOW_MS + 1,
  }, Number.NaN), null);
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: 1.5,
  }, NOW_MS), null);
});


// Recorded from the owner's X500 on 2026-10-06: mode 2 set permanently from
// the Vasco app, and the unit still calling its control mode "schedule".
// Passing `controlMode` through made the device report "Schedule" beside a
// control duration of "permanent".
test('a permanent setting is manual even while the unit still calls itself schedule', () => {
  const recorded = { controlMode: 'schedule', manualSettingActiveTill: -1 };

  assert.equal(controlStateValue(recorded, NOW_MS), 'manual');
  assert.equal(controlDurationValue(recorded, NOW_MS), 'permanent');
});

test('a timed override still running is manual, an expired one is not', () => {
  assert.equal(controlStateValue({
    controlMode: 'schedule', manualSettingActiveTill: NOW_MS + 60_000,
  }, NOW_MS), 'manual');
  assert.equal(controlStateValue({
    controlMode: 'schedule', manualSettingActiveTill: NOW_MS - 60_000,
  }, NOW_MS), 'schedule');
});

// Deliberate: bounded by the schedule, so not a manual override. The control
// duration already distinguishes it as `until_schedule`.
test('a setting that runs until the next schedule change keeps the unit own state', () => {
  assert.equal(controlStateValue({
    controlMode: 'schedule', manualSettingActiveTill: 0,
  }, NOW_MS), 'schedule');
  assert.equal(controlStateValue({
    controlMode: 'manual', manualSettingActiveTill: 0,
  }, NOW_MS), 'manual');
});

test('control state and control duration can never contradict each other', () => {
  for (const controlMode of ['schedule', 'manual', 'nonsense', null]) {
    for (const manualSettingActiveTill of [-1, 0, NOW_MS + 60_000, NOW_MS - 60_000]) {
      const state = { controlMode, manualSettingActiveTill };
      const duration = controlDurationValue(state, NOW_MS);
      const controlState = controlStateValue(state, NOW_MS);
      if (duration === 'permanent' || duration === 'timed') {
        assert.equal(controlState, 'manual',
          `${duration} must report a manual state, got ${controlState}`);
      }
    }
  }
});

test('control state rejects unusable input the same way control duration does', () => {
  assert.equal(controlStateValue(null, NOW_MS), null);
  assert.equal(controlStateValue({ controlMode: 'schedule' }, Number.NaN), null);
  assert.equal(controlStateValue({ controlMode: 'nonsense', manualSettingActiveTill: 0 }, NOW_MS), null);
});
