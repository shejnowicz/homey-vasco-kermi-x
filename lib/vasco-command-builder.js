const { MODES } = require('./vasco-modes');

function buildModeCommand(raw, { mode, duration, nowMs }) {
  const requestedLevel = modeToLevel(mode);
  const command = cloneRaw(raw);

  delete command.requestedLevel;
  command.nextParameter = 'requestedLevel';
  command.nextValue = requestedLevel;

  switch (duration?.type) {
    case 'schedule':
      command.controlMode = 'schedule';
      command.manualSettingActiveTill = 0;
      return command;
    case 'permanent':
      command.manualSettingActiveTill = -1;
      return command;
    case 'minutes': {
      const minutes = validatedMinutes(duration.minutes);
      command.controlMode = 'manual';
      command.manualSettingActiveTill = validatedNow(nowMs) + (minutes * 60_000);
      return command;
    }
    default:
      throw new RangeError('Vasco mode duration is unsupported');
  }
}

function buildFireplaceCommand(raw, { minutes }) {
  const command = cloneRaw(raw);

  command.fireplaceModeTime = validatedFireplaceMinutes(minutes);
  command.nextParameter = 'fireplaceModeTime';
  command.nextValue = command.fireplaceModeTime;
  return command;
}

function buildFireplaceEnableCommand(raw, { minutes }) {
  const command = buildFireplaceCommand(raw, { minutes });

  restoreRawProperty(command, raw, 'nextParameter');
  restoreRawProperty(command, raw, 'nextValue');
  command.fireplaceModeStatus = 1;
  return command;
}

function isFireplaceCommand(command) {
  return command?.nextParameter === 'fireplaceModeTime'
    && command.nextValue === command.fireplaceModeTime
    && Number.isInteger(command.fireplaceModeTime)
    && command.fireplaceModeTime >= 0
    && command.fireplaceModeTime <= 1440;
}

function isModeConfirmed(state, request) {
  const requestedLevel = MODES[request?.mode];
  if (requestedLevel === undefined || state?.mode !== requestedLevel) {
    return false;
  }

  switch (request?.duration?.type) {
    case 'schedule':
      return state.controlMode === 'schedule' && state.manualSettingActiveTill === 0;
    case 'permanent':
      return state.manualSettingActiveTill === -1;
    case 'minutes':
      return isValidMinutes(request.duration.minutes)
        && Number.isFinite(request.nowMs)
        && state.controlMode === 'manual'
        && state.manualSettingActiveTill === request.nowMs + (request.duration.minutes * 60_000);
    default:
      return false;
  }
}

function isFireplaceConfirmed(state, enabled) {
  return state?.fireplaceModeStatus === (enabled ? 1 : 0);
}

function cloneRaw(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('A Vasco device object is required');
  }

  return structuredClone(raw);
}

function restoreRawProperty(command, raw, property) {
  if (Object.hasOwn(raw, property)) {
    command[property] = raw[property];
  } else {
    delete command[property];
  }
}

function modeToLevel(mode) {
  if (!Object.hasOwn(MODES, mode)) {
    throw new RangeError('Vasco mode is unsupported');
  }

  return MODES[mode];
}

function validatedMinutes(minutes) {
  if (!isValidMinutes(minutes)) {
    throw new RangeError('Vasco duration must be a whole number of minutes from 1 to 1440');
  }

  return minutes;
}

function validatedFireplaceMinutes(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw new RangeError('Vasco Fireplace duration must be a whole number from 0 to 1440 minutes');
  }

  return minutes;
}

function isValidMinutes(minutes) {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
}

function validatedNow(nowMs) {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('nowMs must be a finite Unix epoch millisecond value');
  }

  return nowMs;
}

module.exports = {
  buildFireplaceCommand,
  buildFireplaceEnableCommand,
  buildModeCommand,
  isFireplaceCommand,
  isFireplaceConfirmed,
  isModeConfirmed,
};
