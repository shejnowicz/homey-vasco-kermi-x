const test = require('node:test');
const assert = require('node:assert/strict');

const { MODES } = require('../../lib/vasco-modes');
const {
  buildFireplaceEnableCommand,
  buildModeCommand,
  isFireplaceConfirmed,
  isModeConfirmed,
} = require('../../lib/vasco-command-builder');

const rawDevice = {
  bridgeId: 'synthetic-bridge',
  deviceId: 'synthetic-device',
  product: 'Vasco X500',
  requestedLevel: 2,
  nextParameter: 'requestedLevel',
  nextValue: 2,
  controlMode: 'manual',
  manualSettingActiveTill: 1_700_000_000_000,
  fireplaceModeStatus: 0,
  fireplaceModeTime: 5,
  unknownCloudField: {
    calibration: [4, 8, 15],
  },
};

test('buildModeCommand preserves the raw object and changes only schedule command fields', () => {
  const original = structuredClone(rawDevice);

  const command = buildModeCommand(rawDevice, {
    mode: 'high',
    duration: { type: 'schedule' },
  });

  assert.deepEqual(rawDevice, original);
  assert.notStrictEqual(command, rawDevice);
  assert.notStrictEqual(command.unknownCloudField, rawDevice.unknownCloudField);
  assert.equal(Object.hasOwn(command, 'requestedLevel'), false);
  assert.deepEqual(command, {
    ...withoutRequestedLevel(original),
    nextParameter: 'requestedLevel',
    nextValue: 3,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
  });
});

test('buildModeCommand encodes every supported mode as a permanent command', () => {
  const expectedModes = {
    low: 1,
    medium: 2,
    high: 3,
    auto: 4,
    holidays: 6,
    guests: 7,
  };

  assert.deepEqual({ ...MODES }, expectedModes);
  for (const [mode, requestedLevel] of Object.entries(expectedModes)) {
    const command = buildModeCommand(rawDevice, {
      mode,
      duration: { type: 'permanent' },
    });

    assert.deepEqual(command, {
      ...withoutRequestedLevel(rawDevice),
      nextParameter: 'requestedLevel',
      nextValue: requestedLevel,
      manualSettingActiveTill: -1,
    });
  }
});

test('buildModeCommand uses literal millisecond duration math for a timed manual override', () => {
  const command = buildModeCommand(rawDevice, {
    mode: 'auto',
    duration: { type: 'minutes', minutes: 30 },
    nowMs: 1_700_000_000_000,
  });

  assert.deepEqual(command, {
    ...withoutRequestedLevel(rawDevice),
    nextParameter: 'requestedLevel',
    nextValue: 4,
    controlMode: 'manual',
    manualSettingActiveTill: 1_700_001_800_000,
  });
});

function withoutRequestedLevel(device) {
  const clone = structuredClone(device);
  delete clone.requestedLevel;
  return clone;
}

test('buildModeCommand rejects unsupported controller mode and invalid minute durations', () => {
  assert.throws(
    () => buildModeCommand(rawDevice, { mode: 5, duration: { type: 'permanent' } }),
    RangeError,
  );
  assert.throws(
    () => buildModeCommand(rawDevice, { mode: 'controller', duration: { type: 'permanent' } }),
    RangeError,
  );

  for (const minutes of [0, 1.5, 1441, Number.NaN]) {
    assert.throws(
      () => buildModeCommand(rawDevice, {
        mode: 'low',
        duration: { type: 'minutes', minutes },
        nowMs: 1_700_000_000_000,
      }),
      RangeError,
      `${minutes} minutes should be rejected`,
    );
  }
});

test('buildModeCommand rejects inherited property names as modes', () => {
  for (const mode of ['toString', 'constructor']) {
    assert.throws(
      () => buildModeCommand(rawDevice, { mode, duration: { type: 'permanent' } }),
      RangeError,
      `${mode} should not be accepted as a mode`,
    );
  }
});

test('mode mapping cannot be mutated or extended to admit controller level 5', () => {
  assert.equal(Object.getPrototypeOf(MODES), null);
  assert.equal(Object.isFrozen(MODES), true);
  assert.equal(Reflect.set(MODES, 'controller', 5), false);
  assert.equal(Object.hasOwn(MODES, 'controller'), false);
  assert.throws(
    () => buildModeCommand(rawDevice, { mode: 'controller', duration: { type: 'permanent' } }),
    RangeError,
  );
});

test('buildFireplaceEnableCommand preserves unknown fields and sets the validated enable fields', () => {
  const original = structuredClone(rawDevice);

  const command = buildFireplaceEnableCommand(rawDevice, { minutes: 45 });

  assert.deepEqual(rawDevice, original);
  assert.deepEqual(command, {
    ...original,
    fireplaceModeStatus: 1,
    fireplaceModeTime: 45,
  });

  for (const minutes of [0, 1441]) {
    assert.throws(
      () => buildFireplaceEnableCommand(rawDevice, { minutes }),
      RangeError,
    );
  }
});

test('confirmation helpers match observed mapped state', () => {
  assert.equal(isModeConfirmed({
    mode: 3,
    requestedMode: 3,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
  }, {
    mode: 'high',
    duration: { type: 'schedule' },
  }), true);
  assert.equal(isModeConfirmed({
    mode: 6,
    requestedMode: 6,
    controlMode: 'manual',
    manualSettingActiveTill: -1,
  }, {
    mode: 'holidays',
    duration: { type: 'permanent' },
  }), true);
  assert.equal(isModeConfirmed({
    mode: 4,
    requestedMode: 4,
    controlMode: 'manual',
    manualSettingActiveTill: 1_700_001_800_000,
  }, {
    mode: 'auto',
    duration: { type: 'minutes', minutes: 30 },
    nowMs: 1_700_000_000_000,
  }), true);
  assert.equal(isModeConfirmed({
    mode: 4,
    requestedMode: 4,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
  }, {
    mode: 'high',
    duration: { type: 'schedule' },
  }), false);
  assert.equal(isFireplaceConfirmed({ fireplaceModeStatus: 1 }, true), true);
  assert.equal(isFireplaceConfirmed({ fireplaceModeStatus: 0 }, true), false);
  assert.equal(isFireplaceConfirmed({ fireplaceModeStatus: 0 }, false), true);
});

test('isModeConfirmed rejects invalid timed duration boundaries', () => {
  const nowMs = 1_700_000_000_000;

  for (const minutes of [0, 1.5, 1441]) {
    assert.equal(isModeConfirmed({
      mode: 4,
      requestedMode: 4,
      controlMode: 'manual',
      manualSettingActiveTill: nowMs + (minutes * 60_000),
    }, {
      mode: 'auto',
      duration: { type: 'minutes', minutes },
      nowMs,
    }), false, `${minutes} minutes should not be confirmed`);
  }
});
