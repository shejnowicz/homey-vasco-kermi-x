const { createHash } = require('node:crypto');

const { VascoProtocolError } = require('./vasco-errors');

const REQUIRED_FIELDS = [
  'bridgeId',
  'deviceId',
  'product',
  'level',
  'requestedLevel',
  'controlMode',
  'fanSpeedInlet',
  'fanSpeedExhaust',
];

function discoverVentilationDevices(configuration) {
  const deviceProperties = Array.isArray(configuration?.deviceProperties)
    ? configuration.deviceProperties
    : [];

  return deviceProperties
    .filter(isVentilationCandidate)
    .map((raw) => {
      assertSupportedDevice(raw);

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
  const missingFields = REQUIRED_FIELDS.filter(field => !hasValue(raw, field));

  if (missingFields.length > 0) {
    const product = typeof raw?.product === 'string' && raw.product.length > 0
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

function hasValue(object, field) {
  return object !== null
    && typeof object === 'object'
    && object[field] !== null
    && object[field] !== undefined;
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
