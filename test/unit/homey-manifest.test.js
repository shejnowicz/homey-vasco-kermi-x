const { readFileSync } = require('node:fs');
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
  'vasco_test_connection',
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

  assert.equal(driver.class, 'sensor');
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
    'vasco_test_connection',
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
  assert.equal(fireplace.setable, true);
  assert.ok(diagnostics.every(capability => capability.getable && !capability.setable));
});

test('test connection is only a stateless maintenance action', () => {
  const driver = readJson('drivers', 'vasco-kermi-x', 'driver.compose.json');
  const button = readJson('.homeycompose', 'capabilities', 'vasco_test_connection.json');
  const action = driver.capabilitiesOptions.vasco_test_connection;

  assert.equal(button.type, 'boolean');
  assert.equal(button.uiComponent, 'button');
  assert.equal(button.getable, false);
  assert.equal(button.setable, true);
  assert.equal(action.maintenanceAction, true);
  assert.equal(typeof action.title.en, 'string');
  assert.equal(typeof action.title.pl, 'string');
  assert.equal(typeof action.desc.en, 'string');
  assert.equal(typeof action.desc.pl, 'string');
});
