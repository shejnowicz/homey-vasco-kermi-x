const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', '..');

function readJson(...pathParts) {
  return JSON.parse(readFileSync(join(root, ...pathParts), 'utf8'));
}

const requiredCapabilities = [
  'vasco_mode',
  'measure_temperature.indoor',
  'measure_temperature.outdoor',
  'vasco_supply_fan',
  'vasco_exhaust_fan',
  'vasco_bypass',
  'vasco_control_state',
  'vasco_override_end',
  'vasco_fireplace',
  'alarm_filter',
  'alarm_generic',
  'alarm_defrost',
  'alarm_rf',
  'button.test_connection',
  'button.enable_fireplace',
  'measure_vasco_mode',
];

const requiredSettings = [
  'vasco_email',
  'vasco_password',
  'poll_interval',
  'default_duration_type',
  'default_duration_minutes',
  'default_fireplace_minutes',
];

test('Homey Compose manifest exposes the Vasco device contract', () => {
  const driver = readJson('drivers', 'vasco-kermi-x', 'driver.compose.json');
  const settings = readJson('drivers', 'vasco-kermi-x', 'driver.settings.compose.json');
  const english = readJson('locales', 'en.json');
  const polish = readJson('locales', 'pl.json');

  assert.equal(driver.class, 'fan');
  assert.deepEqual(driver.connectivity, ['cloud']);
  assert.deepEqual(driver.capabilities, requiredCapabilities);
  assert.deepEqual(settings.map(setting => setting.id), requiredSettings);

  const settingsById = Object.fromEntries(settings.map(setting => [setting.id, setting]));
  assert.equal(settingsById.vasco_password.type, 'password');
  assert.deepEqual(
    settingsById.poll_interval.values.map(option => option.id),
    ['30', '60', '120', '300', '600'],
  );
  assert.equal(settingsById.poll_interval.value, '60');
  const duration = settingsById.default_duration_type;
  assert.equal(duration.value, 'schedule');
  assert.match(duration.hint.en, /device.*Flow/i);
  assert.match(duration.hint.pl, /urządzeni.*Flow/i);
  assert.match(duration.hint.en, /next schedule event.*resume.*control/i);
  assert.match(duration.hint.pl, /następne zdarzenie harmonogramu.*wznowi.*sterowanie/i);
  assert.match(duration.hint.en, /Flow.*permanent.*until next schedule.*timed/i);
  assert.match(duration.hint.pl, /Flow.*na stałe.*do następnej zmiany harmonogramu.*czas/i);
  for (const id of ['default_duration_minutes', 'default_fireplace_minutes']) {
    assert.equal(settingsById[id].min, 1);
    assert.equal(settingsById[id].max, 1440);
  }

  for (const id of requiredSettings) {
    assert.equal(typeof settingsById[id].label.en, 'string');
    assert.equal(typeof settingsById[id].label.pl, 'string');
    assert.equal(typeof english.settings[id], 'string');
    assert.equal(typeof polish.settings[id], 'string');
  }
});

test('custom capabilities have complete bilingual UI metadata', () => {
  const capabilityIds = [
    'vasco_mode',
    'vasco_supply_fan',
    'vasco_exhaust_fan',
    'vasco_bypass',
    'vasco_control_state',
    'vasco_override_end',
    'vasco_fireplace',
    'alarm_filter',
    'alarm_defrost',
    'alarm_rf',
  ];

  for (const id of capabilityIds) {
    const capability = readJson('.homeycompose', 'capabilities', `${id}.json`);
    assert.equal(typeof capability.title.en, 'string', `${id} needs an English title`);
    assert.equal(typeof capability.title.pl, 'string', `${id} needs a Polish title`);
    if (capability.type === 'number') {
      assert.equal(typeof capability.units.en, 'string', `${id} needs English units`);
      assert.equal(typeof capability.units.pl, 'string', `${id} needs Polish units`);
    }
  }

  const mode = readJson('.homeycompose', 'capabilities', 'vasco_mode.json');
  const fireplace = readJson('.homeycompose', 'capabilities', 'vasco_fireplace.json');
  const modeNumber = readJson('.homeycompose', 'capabilities', 'measure_vasco_mode.json');
  const diagnostics = [
    'vasco_supply_fan',
    'vasco_exhaust_fan',
    'vasco_bypass',
    'vasco_control_state',
    'vasco_override_end',
    'alarm_filter',
    'alarm_defrost',
    'alarm_rf',
  ].map(id => readJson('.homeycompose', 'capabilities', `${id}.json`));

  assert.equal(mode.setable, true);
  assert.equal(fireplace.setable, false);
  assert.equal(fireplace.uiComponent, 'sensor');
  assert.equal(modeNumber.type, 'number');
  assert.equal(modeNumber.getable, true);
  assert.equal(modeNumber.setable, false);
  assert.equal(modeNumber.min, 1);
  assert.equal(modeNumber.max, 7);
  assert.equal(modeNumber.step, 1);
  assert.equal(modeNumber.decimals, 0);
  assert.equal(Object.hasOwn(modeNumber, 'units'), false);
  assert.equal(typeof modeNumber.title.en, 'string');
  assert.equal(typeof modeNumber.title.pl, 'string');
  assert.ok(diagnostics.every(capability => capability.getable && !capability.setable));
});

test('test connection derives from the system button as a maintenance action', () => {
  const driver = readJson('drivers', 'vasco-kermi-x', 'driver.compose.json');
  const capabilityId = 'button.test_connection';
  const action = driver.capabilitiesOptions[capabilityId];

  assert.ok(driver.capabilities.includes(capabilityId));
  assert.equal(capabilityId.split('.')[0], 'button');
  assert.equal(
    existsSync(join(root, '.homeycompose', 'capabilities', 'button.json')),
    false,
    'system button must not be overridden by an app capability',
  );
  assert.equal(
    existsSync(join(root, '.homeycompose', 'capabilities', 'vasco_test_connection.json')),
    false,
    'legacy custom test-connection capability must be removed',
  );
  assert.equal(action.maintenanceAction, true);
  assert.equal(typeof action.title.en, 'string');
  assert.equal(typeof action.title.pl, 'string');
  assert.equal(typeof action.desc.en, 'string');
  assert.equal(typeof action.desc.pl, 'string');
});

test('Fireplace enable derives from the system button as an explicit control', () => {
  const driver = readJson('drivers', 'vasco-kermi-x', 'driver.compose.json');
  const capabilityId = 'button.enable_fireplace';
  const action = driver.capabilitiesOptions[capabilityId];

  assert.ok(driver.capabilities.includes(capabilityId));
  assert.equal(capabilityId.split('.')[0], 'button');
  assert.equal(
    existsSync(join(root, '.homeycompose', 'capabilities', 'button.json')),
    false,
    'system button must not be overridden by an app capability',
  );
  assert.equal(typeof action.title.en, 'string');
  assert.equal(typeof action.title.pl, 'string');
  assert.equal(typeof action.desc.en, 'string');
  assert.equal(typeof action.desc.pl, 'string');
});
