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
    effectiveLevel: 2,
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
  assert.equal(toDeviceState(device).mode, device.level);
  assert.equal(toDeviceState(device).effectiveLevel, device.level);
});

test('maps known state properties and represents absent optional temperatures as null', () => {
  const state = toDeviceState(fixture.deviceProperties[1]);

  assert.deepEqual(state, {
    product: 'Kermi X350',
    softwareVersion: '2.0.0',
    mode: 4,
    effectiveLevel: 4,
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


test('observed X500 Controller level 13 maps to canonical mode 5 without changing raw state', () => {
  const raw = realX500Shape({ level: 13, requestedLevel: null });
  const before = structuredClone(raw);
  const state = toDeviceState(raw);
  assert.equal(state.mode, 5);
  assert.equal(state.effectiveLevel, 5); // the 13 normalization is about the effective scale
  assert.deepEqual(raw, before);
  const { isModeConfirmed } = require('../../lib/vasco-command-builder');
  assert.equal(isModeConfirmed(state, { mode: 'controller', duration: { type: 'schedule' } }), true);
});

test('Controller reported as effective level 13 alongside requestedLevel 5 stays mode 5', () => {
  const state = toDeviceState(realX500Shape({ level: 13, requestedLevel: 5 }));

  assert.equal(state.mode, 5);
  assert.equal(state.effectiveLevel, 5);
  const { isModeConfirmed } = require('../../lib/vasco-command-builder');
  assert.equal(
    isModeConfirmed(state, { mode: 'controller', duration: { type: 'schedule' } }),
    true,
  );
});

test('the selected mode follows requestedLevel while the effective level follows level', () => {
  const holidays = toDeviceState(realX500Shape({ level: 4, requestedLevel: 6 }));

  assert.equal(holidays.mode, 6);
  assert.equal(holidays.effectiveLevel, 4);

  const controller = toDeviceState(realX500Shape({ level: 2, requestedLevel: 5 }));
  assert.equal(controller.mode, 5);
  assert.equal(controller.effectiveLevel, 2);
});

test('a Holidays selection confirms even though the effective level differs', () => {
  const { isModeConfirmed } = require('../../lib/vasco-command-builder');
  const state = toDeviceState(realX500Shape({
    level: 4,
    requestedLevel: 6,
    controlMode: 'manual',
    manualSettingActiveTill: -1,
  }));

  assert.equal(
    isModeConfirmed(state, { mode: 'holidays', duration: { type: 'permanent' } }),
    true,
  );
  assert.equal(
    isModeConfirmed(state, { mode: 'auto', duration: { type: 'permanent' } }),
    false,
  );
});

test('a missing requestedLevel falls back to the effective level for both values', () => {
  assert.deepEqual(
    pickLevels(toDeviceState(realX500Shape({ level: 5, requestedLevel: null }))),
    { mode: 5, effectiveLevel: 5 },
  );
  assert.deepEqual(
    pickLevels(toDeviceState(realX500Shape({ level: 12, requestedLevel: null }))),
    { mode: 12, effectiveLevel: 12 },
  );
  assert.deepEqual(
    pickLevels(toDeviceState(realX500Shape({ level: 13, requestedLevel: null }))),
    { mode: 5, effectiveLevel: 5 },
  );
});

function pickLevels({ mode, effectiveLevel }) {
  return { mode, effectiveLevel };
}

// Recorded from the owner's X500 overnight on 2026-10-06. The unit had been
// set to mode 1 "until the next schedule change" and was running there, while
// `requestedLevel` still held 2 from an override made the evening before.
// Reading the mode from `requestedLevel` made the schedule flow retry five
// times and then report a failure for a change that had succeeded.
test('a setting that runs until the next schedule change takes the mode from nextValue', () => {
  const state = toDeviceState(realX500Shape({
    level: 1,
    requestedLevel: 2,
    nextParameter: 'requestedLevel',
    nextValue: 1,
    manualSettingActiveTill: 0,
    actualFanSpeedInlet: 26,
    actualFanSpeedExhaust: 26,
  }));

  assert.equal(state.mode, 1);
  assert.equal(state.effectiveLevel, 1);
});

test('a permanent setting takes the mode from requestedLevel', () => {
  const state = toDeviceState(realX500Shape({
    level: 3,
    requestedLevel: 3,
    nextParameter: 'requestedLevel',
    nextValue: 1,
    manualSettingActiveTill: -1,
  }));

  assert.equal(state.mode, 3);
});

test('a unit reporting neither field falls back to the effective level', () => {
  const state = toDeviceState(realX500Shape({
    level: 2,
    requestedLevel: null,
    nextParameter: null,
    nextValue: null,
    manualSettingActiveTill: 0,
  }));

  assert.equal(state.mode, 2);
});

test('nextValue is ignored when it does not name the mode field', () => {
  const state = toDeviceState(realX500Shape({
    level: 2,
    requestedLevel: 3,
    nextParameter: 'somethingElse',
    nextValue: 1,
    manualSettingActiveTill: 0,
  }));

  assert.equal(state.mode, 3);
});
