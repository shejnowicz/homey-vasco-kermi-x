'use strict';

function controlDurationValue(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object' || !Number.isSafeInteger(nowMs)) return null;
  const { controlMode, manualSettingActiveTill } = state;
  if (!Number.isSafeInteger(manualSettingActiveTill)) return null;
  if (controlMode === 'schedule' && manualSettingActiveTill === 0) {
    return 'until_schedule';
  }
  if (controlMode === 'manual' && manualSettingActiveTill === -1) {
    return 'permanent';
  }
  if (controlMode === 'manual' && manualSettingActiveTill > nowMs) {
    return 'timed';
  }
  return null;
}

module.exports = { controlDurationValue };
