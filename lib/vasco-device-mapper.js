const { createHash } = require('node:crypto');

const { VascoProtocolError } = require('./vasco-errors');

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
    mode: optionalValue(raw.level),
    requestedMode: raw.requestedLevel ?? raw.level,
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
