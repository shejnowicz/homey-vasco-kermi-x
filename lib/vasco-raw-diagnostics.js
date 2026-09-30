'use strict';

// TEMPORARY DIAGNOSTIC (remove after the mode-field question is settled)
//
// We cannot tell which field of the Vasco cloud response reflects the mode the
// unit is really in: with Holidays selected the unit reported `level: 4` and no
// usable `requestedLevel`, and on another occasion it physically ran at level 1
// while the reported requested mode stayed 2. Instead of guessing again, this
// module keeps a redacted copy of the raw device object - exactly as the cloud
// delivered it, before `toDeviceState` maps anything - in the APP settings, so
// it can be read back with:
//
//   homey api apps get-app-settings --id com.shejnowicz.vasco-kermi-x
//
// It must never change app behaviour: every entry point swallows its own
// errors and does nothing at all without a usable settings manager.

const RAW_PAYLOAD_SETTINGS_KEY = 'diag_raw_payload';
const MAX_ENTRIES = 12;
const MAX_STRING_LENGTH = 80;
const MAX_DEPTH = 8;
const MASK = '[redacted]';

// Conservative by design: a key whose NAME looks personal, secret or
// identifying is masked whatever its value type. That also masks a few numbers
// we would have liked to keep - `bypassPosition` matches /pass/, `serial` and
// `macAddress` are identity - which is the price of never shipping the owner's
// account credentials into a settings value.
const SENSITIVE_KEY = /pass|pwd|token|secret|auth|cookie|session|mail|user|login|key|serial|mac|address|street|city|zip|postal|lat|lon|gps/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

// The command path has no Homey handle of its own, so it reuses the settings
// manager the poll path hands over on its first capture.
let sharedSettings = null;

function redactRawPayload(value) {
  return redactValue(value, 0, new WeakSet());
}

function redactValue(value, depth, seen) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'string') return redactString(value);
  if (type !== 'object') return null;

  if (seen.has(value)) return MASK;
  if (depth >= MAX_DEPTH) return MASK;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(entry => redactValue(entry, depth + 1, seen));
  }

  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key)
      ? MASK
      : redactValue(entry, depth + 1, seen);
  }
  return redacted;
}

function redactString(value) {
  if (value.length > MAX_STRING_LENGTH) return MASK;
  if (EMAIL_LIKE.test(value)) return MASK;
  return value;
}

// Single capture point helper: one call per place that receives a raw device
// object. `settings` is optional - the poll path passes `this.homey.settings`,
// the command path relies on the manager remembered from that first call.
function captureRawPayload(source, raw, settings = null) {
  try {
    if (isUsableSettings(settings)) sharedSettings = settings;
    const manager = isUsableSettings(settings) ? settings : sharedSettings;
    if (!manager) return false;

    const redacted = redactRawPayload(raw);
    const serialized = JSON.stringify(redacted);
    const entries = readEntries(manager);
    const newest = entries[entries.length - 1];
    // A 60-second poll must not churn the settings: only an actually changed
    // payload is written, which leaves the newest stored entry in place.
    if (newest && JSON.stringify(newest.raw) === serialized) return false;

    entries.push({ at: new Date().toISOString(), source, raw: redacted });
    const result = manager.set(
      RAW_PAYLOAD_SETTINGS_KEY,
      entries.slice(-MAX_ENTRIES),
    );
    if (result && typeof result.then === 'function') result.catch(() => {});
    return true;
  } catch (error) {
    return false;
  }
}

function readEntries(manager) {
  const stored = manager.get(RAW_PAYLOAD_SETTINGS_KEY);
  return Array.isArray(stored)
    ? stored.filter(entry => entry !== null && typeof entry === 'object')
    : [];
}

function isUsableSettings(settings) {
  return Boolean(settings)
    && typeof settings.get === 'function'
    && typeof settings.set === 'function';
}

// Tests only: the remembered settings manager is module state.
function resetRawDiagnostics() {
  sharedSettings = null;
}

module.exports = {
  MASK,
  MAX_ENTRIES,
  RAW_PAYLOAD_SETTINGS_KEY,
  captureRawPayload,
  redactRawPayload,
  resetRawDiagnostics,
};
