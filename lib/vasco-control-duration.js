'use strict';

/** `manualSettingActiveTill` uses -1 to mean "this setting has no end". */
const PERMANENT_UNTIL = -1;

function controlDurationValue(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object' || !Number.isSafeInteger(nowMs)) return null;
  const { manualSettingActiveTill } = state;
  if (!Number.isSafeInteger(manualSettingActiveTill)) return null;
  if (manualSettingActiveTill === 0) {
    return 'until_schedule';
  }
  if (manualSettingActiveTill === -1) {
    return 'permanent';
  }
  if (manualSettingActiveTill > nowMs) {
    return 'timed';
  }
  if (state.controlMode === 'schedule') {
    return 'until_schedule';
  }
  return null;
}

/**
 * Whether a manual setting is currently in force.
 *
 * The unit's own `controlMode` cannot answer this. Measured on the owner's
 * X500 on 2026-10-06: with mode 2 set PERMANENTLY from the Vasco app it
 * reported `manualSettingActiveTill: -1` while still calling `controlMode`
 * "schedule". Passing that field straight through made the device show
 * "Schedule" next to a control duration of "permanent" - two capabilities
 * contradicting each other on one reading.
 *
 * `isModeConfirmed` already distrusts `controlMode` for permanent settings and
 * checks only `manualSettingActiveTill`; this is the same judgement applied to
 * what the user sees.
 *
 * Deriving both this and `controlDurationValue` from `manualSettingActiveTill`
 * is what makes them consistent: they now read the same field, so they cannot
 * disagree.
 *
 * A setting that runs until the next schedule change (`0`) is deliberately NOT
 * manual: it is bounded by the schedule, the unit calls it schedule, and the
 * control duration already says `until_schedule`.
 */
function controlStateValue(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object' || !Number.isSafeInteger(nowMs)) return null;

  const { manualSettingActiveTill } = state;
  if (Number.isSafeInteger(manualSettingActiveTill)) {
    if (manualSettingActiveTill === PERMANENT_UNTIL) return 'manual';
    if (manualSettingActiveTill > nowMs) return 'manual';
  }

  return state.controlMode === 'schedule' || state.controlMode === 'manual'
    ? state.controlMode
    : null;
}

module.exports = { controlDurationValue, controlStateValue };
