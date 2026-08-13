const { MODES } = require('./vasco-modes');

const VERSION = 1;
const MINUTE_MS = 60_000;
const MAX_MODE_MINUTES = 1_440;
const PICKER_MINUTES = new Set(Array.from({ length: 17 }, (_, index) => (index + 1) * 5));
const ALLOWED_KEYS = new Set([
  'version',
  'priorMode',
  'priorDuration',
  'selectedMinutes',
  'startedAt',
  'endsAt',
  'stoppedAt',
  'suppressUntil',
]);
const MODE_BY_LEVEL = new Map(Object.entries(MODES).map(([mode, level]) => [level, mode]));

function createManagedSession(state, minutes, nowMs) {
  const selectedMinutes = validatedPickerMinutes(minutes);
  const startedAt = validatedNow(nowMs);
  const priorMode = modeFromState(state);

  return {
    version: VERSION,
    priorMode,
    priorDuration: durationFromState(state, startedAt),
    selectedMinutes,
    startedAt,
    endsAt: startedAt + (selectedMinutes * MINUTE_MS),
  };
}

function parseStoredSession(value, nowMs) {
  const now = validatedNow(nowMs);
  const parsed = parseValue(value);
  if (!isValidSession(parsed)) return null;

  const session = cloneSession(parsed);
  if (hasSuppression(session)) {
    return now < session.suppressUntil ? session : null;
  }
  return now < session.endsAt ? session : null;
}

function remainingMinutes(session, nowMs) {
  const now = validatedNow(nowMs);
  if (!isValidSession(session)) return 0;
  return Math.max(0, Math.ceil((session.endsAt - now) / MINUTE_MS));
}

function restorationRequest(session, nowMs) {
  const now = validatedNow(nowMs);
  if (!isValidSession(session)) return null;

  switch (session.priorDuration.type) {
    case 'permanent':
      return { mode: session.priorMode, duration: { type: 'permanent' } };
    case 'schedule':
      return { mode: session.priorMode, duration: { type: 'schedule' } };
    case 'minutes': {
      const minutes = Math.min(
        MAX_MODE_MINUTES,
        Math.ceil((session.priorDuration.endsAt - now) / MINUTE_MS),
      );
      if (minutes < 1) return { mode: session.priorMode, duration: { type: 'schedule' } };
      return {
        mode: session.priorMode,
        duration: { type: 'minutes', minutes },
        nowMs: now,
      };
    }
    default:
      return null;
  }
}

function stoppedSession(session) {
  if (!isValidSession(session)) return null;
  return {
    ...cloneSession(session),
    suppressUntil: session.endsAt,
  };
}

function effectiveFireplaceState(rawActive, session, nowMs) {
  const now = validatedNow(nowMs);
  if (rawActive === true && isValidSession(session)
    && hasSuppression(session) && now < session.suppressUntil) {
    return false;
  }
  return rawActive;
}

function modeFromState(state) {
  if (!isPlainObject(state)) throw new TypeError('A Vasco state snapshot is required');
  const value = state.requestedMode ?? state.mode;
  if (typeof value === 'string' && Object.hasOwn(MODES, value)) return value;
  if (MODE_BY_LEVEL.has(value)) return MODE_BY_LEVEL.get(value);
  throw new RangeError('Vasco state mode is unsupported');
}

function durationFromState(state, nowMs) {
  if (state.controlMode !== 'schedule' && state.controlMode !== 'manual') {
    throw new RangeError('Vasco state control mode is unsupported');
  }
  if (!Number.isSafeInteger(state.manualSettingActiveTill)) {
    throw new TypeError('Vasco state control deadline is required');
  }
  if (state.manualSettingActiveTill === -1) return { type: 'permanent' };
  if (state.controlMode === 'schedule' || state.manualSettingActiveTill <= nowMs) {
    return { type: 'schedule' };
  }
  return { type: 'minutes', endsAt: state.manualSettingActiveTill };
}

function parseValue(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function isValidSession(value) {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
  if (Object.keys(value).some(key => !ALLOWED_KEYS.has(key))) return false;
  if (value.version !== VERSION || !isMode(value.priorMode)
    || !isPickerMinutes(value.selectedMinutes)
    || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.endsAt)
    || value.endsAt !== value.startedAt + (value.selectedMinutes * MINUTE_MS)
    || !isValidPriorDuration(value.priorDuration, value.startedAt)) {
    return false;
  }

  const hasStoppedAt = Object.hasOwn(value, 'stoppedAt');
  const hasSuppressUntil = Object.hasOwn(value, 'suppressUntil');
  if (hasStoppedAt && (!hasSuppressUntil || !Number.isSafeInteger(value.stoppedAt))) {
    return false;
  }
  if (hasSuppressUntil && (!Number.isSafeInteger(value.suppressUntil)
    || value.suppressUntil !== value.endsAt)) {
    return false;
  }
  return true;
}

function isValidPriorDuration(value, startedAt) {
  if (!isPlainObject(value)) return false;
  if (value.type === 'permanent' || value.type === 'schedule') {
    return Object.keys(value).length === 1;
  }
  return value.type === 'minutes'
    && Object.keys(value).length === 2
    && Number.isSafeInteger(value.endsAt)
    && value.endsAt > startedAt;
}

function hasSuppression(session) {
  return Object.hasOwn(session, 'suppressUntil')
    && Number.isSafeInteger(session.suppressUntil)
    && session.suppressUntil === session.endsAt;
}

function cloneSession(session) {
  return {
    ...session,
    priorDuration: { ...session.priorDuration },
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMode(value) {
  return typeof value === 'string' && Object.hasOwn(MODES, value);
}

function validatedPickerMinutes(value) {
  if (!isPickerMinutes(value)) {
    throw new RangeError('Fireplace duration must be a supported five-minute value from 5 to 85');
  }
  return value;
}

function isPickerMinutes(value) {
  return Number.isSafeInteger(value) && PICKER_MINUTES.has(value);
}

function validatedNow(value) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError('nowMs must be a finite Unix epoch millisecond value');
  }
  return value;
}

module.exports = {
  createManagedSession,
  effectiveFireplaceState,
  parseStoredSession,
  remainingMinutes,
  restorationRequest,
  stoppedSession,
};
