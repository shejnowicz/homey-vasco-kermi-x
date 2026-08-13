const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const fixture = require('../fixtures/account-multiple-devices');
const {
  assertSupportedDevice,
  discoverVentilationDevices,
  toDeviceState,
} = require('../../lib/vasco-device-mapper');
const { VascoProtocolError } = require('../../lib/vasco-errors');

function realX500Shape(overrides = {}) {
  return {
    productCategory: 'ventilation',
    productTypeString: 'X500',
    swVersion: 26,
    macAddress: 'synthetic-mac-address',
    serial: 'synthetic-x500-serial',
    level: 2,
    requestedLevel: null,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
    actualFanSpeedInlet: 50,
    actualFanSpeedExhaust: 50,
    indoorTemperature: 25.86,
    outdoorTemperature: 23.4,
    bypassPosition: 100,
    filterDirty: 0,
    defrost: 0,
    faultStatus: 0,
    rFCommunicationStatus: 0,
    fireplaceModeStatus: 0,
    fireplaceModeTime: 5,
    ...overrides,
  };
}

test('discovers compatible ventilation units in account order with stable opaque identities', () => {
  const discovered = discoverVentilationDevices(fixture);

  assert.equal(discovered.length, 2);
  assert.deepEqual(discovered.map(device => ({
    identity: device.identity,
    name: device.name,
    product: device.product,
    bridgeRef: device.bridgeRef,
    deviceRef: device.deviceRef,
  })), [
    {
      identity: createHash('sha256').update('synthetic-gateway-west\u0000synthetic-device-kitchen').digest('hex'),
      name: 'Kitchen ventilation',
      product: 'Vasco X500',
      bridgeRef: 'synthetic-gateway-west',
      deviceRef: 'synthetic-device-kitchen',
    },
    {
      identity: createHash('sha256').update('synthetic-gateway-east\u0000synthetic-device-bedroom').digest('hex'),
      name: 'Bedroom ventilation',
      product: 'Kermi X350',
      bridgeRef: 'synthetic-gateway-east',
      deviceRef: 'synthetic-device-bedroom',
    },
  ]);
  assert.equal(discovered[0].raw, fixture.deviceProperties[0]);
  assert.equal(discovered[1].raw, fixture.deviceProperties[1]);
});

test('ignores unrelated RF devices during ventilation discovery', () => {
  const discovered = discoverVentilationDevices(fixture);

  assert.ok(discovered.every(device => device.deviceRef !== 'synthetic-device-rf'));
});

test('reports malformed ventilation candidates without exposing their private references', () => {
  const malformed = fixture.deviceProperties[3];

  assert.throws(
    () => assertSupportedDevice(malformed),
    (error) => {
      assert.ok(error instanceof VascoProtocolError);
      assert.match(error.message, /Vasco X200/);
      assert.doesNotMatch(error.message, /synthetic-gateway-west/);
      assert.doesNotMatch(error.message, /synthetic-device-incomplete/);
      return true;
    },
  );
});

test('assertSupportedDevice accepts a compatible ventilation unit', () => {
  assert.doesNotThrow(() => assertSupportedDevice(fixture.deviceProperties[0]));
});

test('accepts X500 schedule state with null requestedLevel and uses the effective level', () => {
  const scheduled = realX500Shape();

  assert.doesNotThrow(() => assertSupportedDevice(scheduled));
  const [discovered] = discoverVentilationDevices({ deviceProperties: [scheduled] });
  assert.equal(
    discovered.identity,
    createHash('sha256')
      .update('synthetic-mac-address\u0000synthetic-x500-serial')
      .digest('hex'),
  );
  assert.equal(discovered.product, 'X500');
  assert.deepEqual(toDeviceState(scheduled), {
    product: 'X500',
    softwareVersion: 26,
    mode: 2,
    requestedMode: 2,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
    fanSpeedInlet: 50,
    fanSpeedExhaust: 50,
    indoorTemperature: 25.86,
    outdoorTemperature: 23.4,
    bypassPosition: 100,
    filterDirty: 0,
    defrost: 0,
    faultStatus: 0,
    rfCommunicationStatus: 0,
    fireplaceModeStatus: 0,
    fireplaceModeTime: 5,
  });
});

test('rejects empty or wrongly typed required identity and state fields', () => {
  const supported = fixture.deviceProperties[0];
  const invalidFields = [
    ['bridgeId', ''],
    ['deviceId', 42],
    ['product', '   '],
    ['controlMode', 1],
    ['level', Number.NaN],
    ['requestedLevel', '3'],
    ['requestedLevel', Number.NaN],
    ['requestedLevel', Number.POSITIVE_INFINITY],
    ['fanSpeedInlet', Number.POSITIVE_INFINITY],
    ['fanSpeedExhaust', '39'],
  ];

  for (const [field, value] of invalidFields) {
    assert.throws(
      () => assertSupportedDevice({ ...supported, [field]: value }),
      VascoProtocolError,
      `${field} should be rejected`,
    );
  }
});

test('accepts a device when Vasco omits optional requestedLevel after a write', () => {
  const device = realX500Shape();
  delete device.requestedLevel;

  assert.doesNotThrow(() => assertSupportedDevice(device));
  assert.equal(toDeviceState(device).requestedMode, device.level);
});

test('maps known state properties and represents absent optional temperatures as null', () => {
  const state = toDeviceState(fixture.deviceProperties[1]);

  assert.deepEqual(state, {
    product: 'Kermi X350',
    softwareVersion: '2.0.0',
    mode: 4,
    requestedMode: 4,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
    fanSpeedInlet: 36,
    fanSpeedExhaust: 35,
    indoorTemperature: 20.8,
    outdoorTemperature: null,
    bypassPosition: 15,
    filterDirty: 1,
    defrost: 0,
    faultStatus: 0,
    rfCommunicationStatus: 0,
    fireplaceModeStatus: 1,
    fireplaceModeTime: 20,
  });
});
