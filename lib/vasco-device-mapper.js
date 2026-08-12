const { createHash } = require('node:crypto');

const { VascoProtocolError } = require('./vasco-errors');

const REQUIRED_STRING_FIELDS = [
  'bridgeId',
  'deviceId',
  'product',
  'controlMode',
];

const REQUIRED_NUMBER_FIELDS = [
  'level',
  'requestedLevel',
  'fanSpeedInlet',
  'fanSpeedExhaust',
];

function discoverVentilationDevices(configuration) {
  const deviceProperties = Array.isArray(configuration?.deviceProperties)
    ? configuration.deviceProperties
    : [];

  return deviceProperties
    .filter(isVentilationCandidate)
    .filter(isSupportedDevice)
    .map((raw) => {
      return {
        identity: createIdentity(raw.bridgeId, raw.deviceId),
        name: raw.name ?? raw.deviceName ?? raw.product,
        product: raw.product,
        bridgeRef: raw.bridgeId,
        deviceRef: raw.deviceId,
        raw,
      };
    });
}

function assertSupportedDevice(raw) {
  if (!isSupportedDevice(raw)) {
    const product = isNonEmptyString(raw?.product)
      ? raw.product
      : 'unknown model';
    throw new VascoProtocolError(
      `Unsupported Vasco ventilation device (${product}): missing required properties`,
    );
  }
}

function toDeviceState(raw) {
  assertSupportedDevice(raw);

  return {
    product: optionalValue(raw.product),
    softwareVersion: optionalValue(raw.softwareVersion),
    mode: optionalValue(raw.level),
    requestedMode: optionalValue(raw.requestedLevel),
    controlMode: optionalValue(raw.controlMode),
    manualSettingActiveTill: optionalValue(raw.manualSettingActiveTill),
    fanSpeedInlet: optionalValue(raw.fanSpeedInlet),
    fanSpeedExhaust: optionalValue(raw.fanSpeedExhaust),
    indoorTemperature: optionalValue(raw.indoorTemperature),
    outdoorTemperature: optionalValue(raw.outdoorTemperature),
    bypassPosition: optionalValue(raw.bypassPosition),
    filterDirty: optionalValue(raw.filterDirty),
    defrost: optionalValue(raw.defrost),
    faultStatus: optionalValue(raw.faultStatus),
    rfCommunicationStatus: optionalValue(raw.rfCommunicationStatus),
    fireplaceModeStatus: optionalValue(raw.fireplaceModeStatus),
    fireplaceModeTime: optionalValue(raw.fireplaceModeTime),
  };
}

function isVentilationCandidate(raw) {
  return typeof raw?.productCategory === 'string'
    && raw.productCategory.toLowerCase() === 'ventilation';
}

function isSupportedDevice(raw) {
  return raw !== null
    && typeof raw === 'object'
    && REQUIRED_STRING_FIELDS.every(field => isNonEmptyString(raw[field]))
    && REQUIRED_NUMBER_FIELDS.every(field => Number.isFinite(raw[field]));
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
