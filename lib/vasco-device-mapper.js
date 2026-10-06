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

/**
 * Which field carries the SELECTED mode depends on how the setting was made,
 * and getting this wrong is not a cosmetic error: the schedule flow verifies
 * the mode it just set, so a stale read makes it retry and then report a
 * failure for a change that actually succeeded.
 *
 * Measured on the owner's X500, most recently on 2026-10-06 by recording the
 * cloud payload across a live mode change:
 *
 * - For a PERMANENT setting (`manualSettingActiveTill === -1`) the unit often
 *   reports no `requestedLevel` at all and carries the selected mode in
 *   `level`. Setting mode 3 permanently produced `level: 3`,
 *   `requestedLevel: null`, `manualSettingActiveTill: -1` - while `nextValue`
 *   still held 1 from a setting made two hours earlier.
 *   `requestedLevel` is filled in, and authoritative, for the modes whose
 *   effective level differs from their mode number: Holidays reports
 *   `level: 4` with `requestedLevel: 6`.
 * - While a setting runs until the next schedule change, `nextValue` carries
 *   the selected mode and `nextParameter` names the field it applies to.
 *   `requestedLevel` keeps whatever an EARLIER override left there. At
 *   midnight the unit was set to mode 1, ran at level 1 with both fans at 26,
 *   and reported `nextValue` 1 while `requestedLevel` still said 2 from the
 *   evening before.
 * - Units that report neither - X500 returns null for `requestedLevel` on a
 *   plain schedule read, which `isSupportedDevice` deliberately tolerates -
 *   fall back to the effective level, as before.
 *
 * The permanent branch therefore decides on its own and never falls through to
 * `nextValue`. `nextValue` describes the NEXT scheduled event, which a
 * permanent setting has overridden; consulting it reported mode 1 for a unit
 * the owner had just put on mode 3, in Homey and in every client reading from
 * Homey.
 */
function selectedMode(raw) {
  if (raw.manualSettingActiveTill === PERMANENT_UNTIL) {
    return Number.isFinite(raw.requestedLevel)
      ? raw.requestedLevel
      : normalizedEffectiveLevel(raw.level);
  }
  if (raw.nextParameter === 'requestedLevel' && Number.isFinite(raw.nextValue)) {
    return raw.nextValue;
  }
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
