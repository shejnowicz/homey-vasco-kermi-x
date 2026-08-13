'use strict';

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
  return null;
}

module.exports = { controlDurationValue };
