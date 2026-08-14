const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', '..');
const modes = ['low', 'medium', 'high', 'auto', 'holidays', 'guests'];

function readJson(...pathParts) {
  return JSON.parse(readFileSync(join(root, ...pathParts), 'utf8'));
}

function readFlow(type, id) {
  return readJson('.homeycompose', 'flow', type, `${id}.json`);
}

test('driver Flow manifest defines every approved bilingual card with safe arguments', () => {
  const driverFlowPath = join(root, 'drivers', 'vasco-kermi-x', 'driver.flow.compose.json');
  assert.equal(existsSync(driverFlowPath), true);
  const driverFlow = readJson('drivers', 'vasco-kermi-x', 'driver.flow.compose.json');

  assert.deepEqual(driverFlow, {});
  assert.equal(
    existsSync(join(root, '.homeycompose', 'flow', 'actions', 'disable_fireplace.json')),
    false,
  );

  const labels = (en, pl, formattedEn = en, formattedPl = pl) => ({
    title: { en, pl },
    titleFormatted: { en: formattedEn, pl: formattedPl },
  });
  const expectedTitles = {
    actions: {
      set_mode_until_schedule: labels('Set operating mode', 'Ustaw tryb pracy', 'Set operating mode to [[mode]] until the next schedule change', 'Ustaw tryb pracy na [[mode]] do następnej zmiany harmonogramu'),
      set_mode_permanent: labels('Set operating mode', 'Ustaw tryb pracy', 'Set operating mode to [[mode]] permanently', 'Ustaw tryb pracy na [[mode]] na stałe'),
      set_mode_for_minutes: labels('Set operating mode', 'Ustaw tryb pracy', 'Set operating mode to [[mode]] for [[minutes]] minutes', 'Ustaw tryb pracy na [[mode]] na [[minutes]] minut'),
      enable_fireplace_for_minutes: labels('Enable Fireplace mode', 'Włącz tryb kominka', 'Enable Fireplace mode for [[minutes]] minutes', 'Włącz tryb kominka na [[minutes]] minut'),
      refresh_state: labels('Refresh state', 'Odśwież stan'),
    },
    conditions: {
      mode_is: labels('Operating mode', 'Tryb pracy', 'Operating mode !{{is|isn\'t}} [[mode]]', 'Tryb pracy !{{to|nie jest}} [[mode]]'),
      fireplace_is_active: labels('Fireplace mode', 'Tryb kominka', 'Fireplace mode !{{is|isn\'t}} active', 'Tryb kominka !{{jest|nie jest}} aktywny'),
      manual_override_is_active: labels('Manual override', 'Ręczne sterowanie', 'Manual override !{{is|isn\'t}} active', 'Ręczne sterowanie !{{jest|nie jest}} aktywne'),
      control_duration_is: labels('Control duration', 'Sposób sterowania', 'Control duration !{{is|isn\'t}} [[duration]]', 'Sposób sterowania !{{to|nie jest}} [[duration]]'),
      filter_attention: labels('Filter attention', 'Uwaga dotycząca filtra', 'Filter !{{requires|doesn\'t require}} attention', 'Filtr !{{wymaga|nie wymaga}} uwagi'),
      fault_present: labels('Fault', 'Usterka', 'Device !{{has|doesn\'t have}} a fault', 'Urządzenie !{{ma|nie ma}} usterki'),
      defrost_active: labels('Defrost', 'Odszranianie', 'Defrost !{{is|isn\'t}} active', 'Odszranianie !{{jest|nie jest}} aktywne'),
    },
    triggers: {
      mode_changed: labels('Operating mode changed', 'Zmieniono tryb pracy'),
      fireplace_enabled: labels('Fireplace mode enabled', 'Włączono tryb kominka', 'Fireplace mode was enabled', 'Włączono tryb kominka'),
      fireplace_disabled: labels('Fireplace mode disabled', 'Wyłączono tryb kominka', 'Fireplace mode was disabled', 'Wyłączono tryb kominka'),
      filter_warning_appeared: labels('Filter warning appeared', 'Pojawiło się ostrzeżenie filtra'),
      fault_appeared: labels('Fault appeared', 'Pojawiła się usterka'),
      fault_cleared: labels('Fault cleared', 'Usterka została usunięta', 'Fault was cleared', 'Usterka została usunięta'),
      device_became_unavailable: labels('Device became unavailable', 'Urządzenie stało się niedostępne'),
      device_became_available: labels('Device became available', 'Urządzenie stało się dostępne'),
    },
  };

  for (const [type, cards] of Object.entries(expectedTitles)) {
    for (const [id, expected] of Object.entries(cards)) {
      const card = readFlow(type, id);
      assert.deepEqual({ title: card.title, titleFormatted: card.titleFormatted }, expected, `${type}/${id}`);
    }
  }
  const modeCard = readFlow('actions', 'set_mode_for_minutes');
  assert.throws(() => assert.deepEqual({
    title: { ...modeCard.title, en: 'Wrong title' },
    titleFormatted: modeCard.titleFormatted,
  }, expectedTitles.actions.set_mode_for_minutes));

  for (const id of ['set_mode_until_schedule', 'set_mode_permanent', 'set_mode_for_minutes', 'mode_is']) {
    const mode = readFlow(id === 'mode_is' ? 'conditions' : 'actions', id).args
      .find(argument => argument.name === 'mode');
    assert.deepEqual(mode.values.map(value => value.id), modes);
  }
  for (const id of ['set_mode_for_minutes', 'enable_fireplace_for_minutes']) {
    const minutes = readFlow('actions', id).args.find(argument => argument.name === 'minutes');
    assert.equal(minutes.type, 'number');
    assert.equal(minutes.min, 1);
    assert.equal(minutes.max, 1440);
  }
  const controlDuration = readFlow('conditions', 'control_duration_is').args
    .find(argument => argument.name === 'duration');
  assert.deepEqual(controlDuration.values, [
    {
      id: 'until_schedule',
      title: {
        en: 'Until next schedule change',
        pl: 'Do następnej zmiany harmonogramu',
      },
    },
    { id: 'permanent', title: { en: 'Permanent', pl: 'Na stałe' } },
    { id: 'timed', title: { en: 'Timed', pl: 'Czasowo' } },
  ]);
  assert.deepEqual(readFlow('triggers', 'mode_changed').tokens.map(token => token.name), [
    'previous_mode',
    'new_mode',
  ]);
});

class HomeyAppDouble {
  configure(homey) {
    this.homey = homey;
    return this;
  }

  log(...args) {
    return this.homey.log(...args);
  }
}

function loadApp() {
  const appPath = require.resolve('../../app');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') return { App: HomeyAppDouble };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[appPath];
    return require(appPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createCard() {
  return {
    listeners: [],
    triggers: [],
    registerRunListener(listener) {
      this.listeners.push(listener);
      return this;
    },
    async trigger(device, tokens) {
      this.triggers.push({ device, tokens });
      return true;
    },
  };
}

function createAppHarness() {
  const actions = new Map();
  const conditions = new Map();
  const triggers = new Map();
  const app = new (loadApp())().configure({
    flow: {
      getActionCard(id) {
        const card = actions.get(id) ?? createCard();
        actions.set(id, card);
        return card;
      },
      getConditionCard(id) {
        const card = conditions.get(id) ?? createCard();
        conditions.set(id, card);
        return card;
      },
      getDeviceTriggerCard(id) {
        const card = triggers.get(id) ?? createCard();
        triggers.set(id, card);
        return card;
      },
    },
    setTimeout,
    clearTimeout,
    notifications: { createNotification: async () => undefined },
    log() {},
  });
  return { app, actions, conditions, triggers };
}

function createDevice() {
  const calls = [];
  const values = new Map([
    ['vasco_mode', 'high'],
    ['vasco_fireplace', true],
    ['vasco_control_state', 'manual'],
    ['vasco_control_duration', 'until_schedule'],
    ['alarm_filter', true],
    ['alarm_generic', true],
    ['alarm_defrost', true],
  ]);
  return {
    calls,
    values,
    getCapabilityValue(capability) {
      return values.get(capability);
    },
    async setOperatingMode(mode, duration) {
      calls.push(['setOperatingMode', mode, duration]);
      return true;
    },
    async setFireplace(...args) {
      calls.push(['setFireplace', ...args]);
      return true;
    },
    async refreshState(options) {
      calls.push(['refreshState', options]);
      return true;
    },
  };
}

test('app registers Flow listeners once, delegates safely, and delivers device transitions', async () => {
  const { app, actions, conditions, triggers } = createAppHarness();
  await app.onInit();
  await app.onInit();
  const device = createDevice();

  assert.equal(actions.get('set_mode_until_schedule').listeners.length, 1);
  assert.equal(conditions.get('mode_is').listeners.length, 1);
  assert.equal(triggers.get('mode_changed').listeners.length, 0);

  await actions.get('set_mode_until_schedule').listeners[0]({ device, mode: 'auto' });
  await actions.get('set_mode_permanent').listeners[0]({ device, mode: 'guests' });
  await actions.get('set_mode_for_minutes').listeners[0]({ device, mode: 'high', minutes: 30 });
  for (const minutes of [1, 90, 1_440]) {
    await actions.get('enable_fireplace_for_minutes').listeners[0]({ device, minutes });
  }
  await actions.get('refresh_state').listeners[0]({ device });
  assert.deepEqual(device.calls, [
    ['setOperatingMode', 'auto', { type: 'schedule' }],
    ['setOperatingMode', 'guests', { type: 'permanent' }],
    ['setOperatingMode', 'high', { type: 'minutes', minutes: 30 }],
    ['setFireplace', 1],
    ['setFireplace', 90],
    ['setFireplace', 1_440],
    ['refreshState', { force: true }],
  ]);

  assert.equal(await conditions.get('mode_is').listeners[0]({ device, mode: 'high' }), true);
  assert.equal(await conditions.get('fireplace_is_active').listeners[0]({ device }), true);
  assert.equal(await conditions.get('manual_override_is_active').listeners[0]({ device }), true);
  const controlDuration = conditions.get('control_duration_is').listeners[0];
  assert.equal(await controlDuration({ device, duration: 'until_schedule' }), true);
  assert.equal(await controlDuration({ device, duration: 'permanent' }), false);
  device.values.set('vasco_control_duration', null);
  for (const duration of ['until_schedule', 'permanent', 'timed']) {
    assert.equal(await controlDuration({ device, duration }), false);
  }
  assert.equal(await conditions.get('filter_attention').listeners[0]({ device }), true);
  assert.equal(await conditions.get('fault_present').listeners[0]({ device }), true);
  assert.equal(await conditions.get('defrost_active').listeners[0]({ device }), true);

  await app.onVascoDeviceTransition(device, 'mode_changed', {
    previous_mode: 'medium',
    new_mode: 'high',
  });
  await app.onVascoDeviceTransition(device, 'fireplace_disabled');
  assert.deepEqual(triggers.get('mode_changed').triggers, [{
    device,
    tokens: { previous_mode: 'medium', new_mode: 'high' },
  }]);
  assert.deepEqual(triggers.get('fireplace_disabled').triggers, [{ device, tokens: {} }]);

  await assert.rejects(
    () => actions.get('set_mode_for_minutes').listeners[0]({ device, mode: 'high', minutes: 0 }),
    /whole number between 1 and 1440/i,
  );
});

test('Fireplace Flow action passes the selected duration as the only device argument', async () => {
  const { app, actions } = createAppHarness();
  await app.onInit();
  const device = createDevice();

  await actions.get('enable_fireplace_for_minutes').listeners[0]({
    device,
    minutes: 45,
  });

  assert.deepEqual(device.calls, [['setFireplace', 45]]);
});

test('Fireplace Flow listener accepts whole boundary minutes and rejects fractions', async () => {
  const { app, actions } = createAppHarness();
  await app.onInit();
  const device = createDevice();
  const run = actions.get('enable_fireplace_for_minutes').listeners[0];

  await run({ device, minutes: 1 });
  await run({ device, minutes: 1_440 });
  await assert.rejects(
    () => run({ device, minutes: 1.5 }),
    /whole number between 1 and 1440/i,
  );

  assert.deepEqual(device.calls, [
    ['setFireplace', 1],
    ['setFireplace', 1_440],
  ]);
});
