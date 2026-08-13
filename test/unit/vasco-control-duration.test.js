'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { controlDurationValue } = require('../../lib/vasco-control-duration');

const NOW_MS = 1_700_000_000_000;

test('maps schedule, permanent, and future timed Vasco control states', () => {
  assert.equal(controlDurationValue({
    controlMode: 'schedule', manualSettingActiveTill: 0,
  }, NOW_MS), 'until_schedule');
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: -1,
  }, NOW_MS), 'permanent');
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: NOW_MS + 1,
  }, NOW_MS), 'timed');
});

test('returns null for unknown, contradictory, and expired control states', () => {
  for (const state of [
    {},
    { controlMode: 'other', manualSettingActiveTill: 0 },
    { controlMode: 'manual', manualSettingActiveTill: 0 },
    { controlMode: 'schedule', manualSettingActiveTill: -1 },
    { controlMode: 'schedule', manualSettingActiveTill: NOW_MS + 1 },
    { controlMode: 'manual', manualSettingActiveTill: NOW_MS },
  ]) assert.equal(controlDurationValue(state, NOW_MS), null);
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
