const { createHash } = require('node:crypto');

const { VascoProtocolError } = require('./vasco-errors');

// X500 reports an active Controller as effective level 13 (observed
// 2026-09-11) while the command scale calls Controller mode 5. The
// normalization belongs to the effective scale, so it also applies to the
// fallback used by units that never report `requestedLevel`.
const CONTROLLER_EFFECTIVE_LEVEL = 13;
const CONTROLLER_MODE = 5;

function discoverVentilationDevices(configuration) {
  const deviceProperties = Array.isArray(configuration?.deviceProperties)
    ? configuration.deviceProperties
    : [];

  return deviceProperties
    .filter(isVentilationCandidate)
    .filter(isSupportedDevice)
    .map((raw) => {
      const bridgeRef = identityPart(raw, 'macAddress', 'bridgeId');
      const deviceRef = identityPart(raw, 'serial', 'deviceId');
      const product = fieldValue(raw, 'productTypeString', 'product');
      return {
        identity: createIdentity(bridgeRef, deviceRef),
        name: raw.name ?? raw.deviceName ?? product,
        product,
        bridgeRef,
        deviceRef,
        raw,
      };
    });
}

function assertSupportedDevice(raw) {
  if (!isSupportedDevice(raw)) {
    const candidateProduct = fieldValue(raw, 'productTypeString', 'product');
    const product = isNonEmptyString(candidateProduct)
      ? candidateProduct
      : 'unknown model';
    throw new VascoProtocolError(
      `Unsupported Vasco ventilation device (${product}): missing required properties`,
    );
  }
}

/** `manualSettingActiveTill` uses -1 to mean "this setting has no end". */
const PERMANENT_UNTIL = -1;
/** `manualSettingActiveTill` uses 0 to mean "until the next schedule change". */
const UNTIL_NEXT_SCHEDULE = 0;

/**
 * Which field carries the SELECTED mode, and getting it wrong is not cosmetic:
 * the schedule flow verifies the mode it just set, so a stale read makes it retry
 * and then report a failure for a change that actually succeeded - and the CO2
 * automation on the hub steps the fan +/-1 from this value, so a wrong one can
 * freeze it or invert its response.
 *
 * The rule is now simple, and it is the one every RECORDED payload supports:
 * `level` is what the unit is doing, and only a PERMANENT setting's
 * `requestedLevel` may override it.
 *
 * Measured on the owner's X500:
 *
 * - 2026-10-06 09:29, mode 3 set permanently from the Vasco app: `level: 3`,
 *   `requestedLevel: null`, `manualSettingActiveTill: -1`, `nextValue: 1` left
 *   over from a setting two hours earlier.
 * - Holidays, permanent: `level: 4` with `requestedLevel: 6`. This is the one
 *   case where the selected mode differs from the effective level, and the unit
 *   does fill `requestedLevel` to say so - hence the permanent branch.
 * - 2026-10-06, mode 1 until the next schedule change: `level: 1`,
 *   `requestedLevel: 2` LEFT OVER from the evening before, `nextValue: 1`.
 * - 2026-10-13 12:33, speed 3 set from the wired panel, until the next schedule
 *   change: `level: 3`, `requestedLevel: null`, `nextValue: 1`,
 *   `manualSettingActiveTill: 0`.
 *
 * Neither `nextValue` nor `requestedLevel` survives that set. `nextValue`
 * describes the NEXT scheduled event; this account's cloud schedule is empty, so
 * it simply holds whatever an earlier setting left and never refreshes.
 * `requestedLevel` was recorded stale under the same condition.
 *
 * The earlier rule took `nextValue` while a setting ran until the next schedule
 * change. It was adopted from the 2026-10-06 sample where `nextValue` and `level`
 * BOTH said 1 - a recording that could not tell the two apart. The 2026-10-13
 * sample is the one that discriminates, and it says `level`.
 *
 * SCOPE: this changes ONLY the `manualSettingActiveTill === 0` branch, which is
 * the one every recording above covers. A timed override is left exactly as it
 * was, because no payload has ever been recorded for one and guessing its shape
 * is what produced the two previous wrong rules here.
 *
 * Holidays and Guests are the exception, and not a guess: their canonical numbers
 * (6, 7) are not levels the unit can report, so `level` carries no information
 * about them at all. There the previous reading of `requestedLevel` stands - the
 * alternative is to report Auto for a Holidays command and have it never confirm.
 * Everything at or below Controller IS its level, directly or through the 13 -> 5
 * normalization, so there `level` decides and the stale `requestedLevel` is ignored.
 */
function selectedMode(raw) {
  if (raw.manualSettingActiveTill === PERMANENT_UNTIL) {
    return Number.isFinite(raw.requestedLevel)
      ? raw.requestedLevel
      : normalizedEffectiveLevel(raw.level);
  }
  if (raw.manualSettingActiveTill === UNTIL_NEXT_SCHEDULE) {
    // `level` is authoritative here - EXCEPT for the modes it cannot express.
    // Holidays runs at effective level 4, which is also Auto's number, and Guests
    // has no recorded level at all. For those the level is not a weaker signal, it
    // is no signal, so the previous reading is kept rather than knowingly breaking
    // a supported command: `isModeConfirmed` requires the canonical mode, and a
    // Holidays-until-schedule command that never confirms retries and then reports
    // a failure for a change that succeeded.
    //
    // Modes 1-3 ARE their level, and Controller is recovered by the 13 -> 5
    // normalization, so for everything at or below Controller the level says it all
    // - and `requestedLevel` is exactly the field recorded stale on 2026-10-06
    // (holding 2 while the unit ran mode 1).
    return Number.isFinite(raw.requestedLevel) && raw.requestedLevel > CONTROLLER_MODE
      ? raw.requestedLevel
      : normalizedEffectiveLevel(raw.level);
  }
  // A timed override still in force, or one whose deadline has passed. No payload
  // has been recorded for either, so this path is left exactly as it was.
  if (Number.isFinite(raw.requestedLevel)) {
    return raw.requestedLevel;
  }
  return normalizedEffectiveLevel(raw.level);
}

function toDeviceState(raw) {
  assertSupportedDevice(raw);

  return {
    product: optionalValue(fieldValue(raw, 'productTypeString', 'product')),
    softwareVersion: optionalValue(fieldValue(raw, 'swVersion', 'softwareVersion')),
    // `level` is the ventilation level the unit is effectively running at.
    // It uses the vendor's own scale, which is not the mode scale: Controller
    // is reported as 13, and a selected mode such as Holidays runs at a level
    // that differs from its mode number.
    effectiveLevel: normalizedEffectiveLevel(raw.level),
    mode: selectedMode(raw),
    controlMode: optionalValue(raw.controlMode),
    manualSettingActiveTill: optionalValue(raw.manualSettingActiveTill),
    fanSpeedInlet: optionalValue(fieldValue(raw, 'actualFanSpeedInlet', 'fanSpeedInlet')),
    fanSpeedExhaust: optionalValue(fieldValue(raw, 'actualFanSpeedExhaust', 'fanSpeedExhaust')),
    indoorTemperature: optionalValue(raw.indoorTemperature),
    outdoorTemperature: optionalValue(raw.outdoorTemperature),
    bypassPosition: optionalValue(raw.bypassPosition),
    filterDirty: optionalValue(raw.filterDirty),
    defrost: optionalValue(raw.defrost),
    faultStatus: optionalValue(raw.faultStatus),
    rfCommunicationStatus: optionalValue(fieldValue(raw, 'rFCommunicationStatus', 'rfCommunicationStatus')),
    fireplaceModeStatus: optionalValue(raw.fireplaceModeStatus),
    fireplaceModeTime: optionalValue(raw.fireplaceModeTime),
  };
}

function isVentilationCandidate(raw) {
  return typeof raw?.productCategory === 'string'
    && raw.productCategory.toLowerCase().includes('vent');
}

function isSupportedDevice(raw) {
  const requestedLevelIsValid = raw?.requestedLevel === undefined
    || raw.requestedLevel === null
    || Number.isFinite(raw.requestedLevel);

  return raw !== null
    && typeof raw === 'object'
    && isNonEmptyString(identityPart(raw, 'macAddress', 'bridgeId'))
    && isNonEmptyString(identityPart(raw, 'serial', 'deviceId'))
    && isNonEmptyString(fieldValue(raw, 'productTypeString', 'product'))
    && isNonEmptyString(raw.controlMode)
    && Number.isFinite(raw.level)
    && Number.isFinite(fieldValue(raw, 'actualFanSpeedInlet', 'fanSpeedInlet'))
    && Number.isFinite(fieldValue(raw, 'actualFanSpeedExhaust', 'fanSpeedExhaust'))
    && requestedLevelIsValid;
}

function fieldValue(raw, primaryName, legacyName) {
  return raw?.[primaryName] ?? raw?.[legacyName];
}

function identityPart(raw, primaryName, legacyName) {
  return fieldValue(raw, primaryName, legacyName);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalValue(value) {
  return value ?? null;
}

function normalizedEffectiveLevel(level) {
  return level === CONTROLLER_EFFECTIVE_LEVEL ? CONTROLLER_MODE : optionalValue(level);
}

function createIdentity(bridgeId, deviceId) {
  return createHash('sha256')
    .update(`${bridgeId}\u0000${deviceId}`)
    .digest('hex');
}

module.exports = {
  assertSupportedDevice,
  discoverVentilationDevices,
  toDeviceState,
};
