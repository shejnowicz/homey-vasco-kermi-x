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
    // The selected operating mode is `requestedLevel` - the very field the
    // command builder writes (docs/api/vasco-cloud-api.md, "Standard modes").
    // Deriving it from `level` instead made Homey report the effective
    // ventilation level as the mode (Holidays observed as Auto on 2026-09-29)
    // and made confirmation impossible for every mode whose effective level
    // differs. Units that omit `requestedLevel` - X500 returns null for it on
    // a schedule read, which `isSupportedDevice` deliberately tolerates - keep
    // the previous behavior through the effective-level fallback.
    mode: Number.isFinite(raw.requestedLevel)
      ? raw.requestedLevel
      : normalizedEffectiveLevel(raw.level),
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
