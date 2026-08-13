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

  const expectedTitles = {
    actions: {
      set_mode_until_schedule: {
        en: 'Set [[device]] operating mode to [[mode]] until the next schedule change',
        pl: 'Ustaw tryb pracy [[device]] na [[mode]] do następnej zmiany harmonogramu',
      },
      set_mode_permanent: {
        en: 'Set [[device]] operating mode to [[mode]] permanently',
        pl: 'Ustaw tryb pracy [[device]] na [[mode]] na stałe',
      },
      set_mode_for_minutes: {
        en: 'Set [[device]] operating mode to [[mode]] for [[minutes]] minutes',
        pl: 'Ustaw tryb pracy [[device]] na [[mode]] na [[minutes]] minut',
      },
      enable_fireplace_for_minutes: {
        en: 'Enable Fireplace mode on [[device]] for [[minutes]] minutes',
        pl: 'Włącz tryb kominka w [[device]] na [[minutes]] minut',
      },
      refresh_state: {
        en: 'Refresh [[device]] state',
        pl: 'Odśwież stan [[device]]',
      },
    },
    conditions: {
      mode_is: {
        en: '[[device]] operating mode !{{is|isn\'t}} [[mode]]',
        pl: 'Tryb pracy [[device]] !{{to|nie jest}} [[mode]]',
      },
      fireplace_is_active: {
        en: 'Fireplace mode on [[device]] !{{is|isn\'t}} active',
        pl: 'Tryb kominka w [[device]] !{{jest|nie jest}} aktywny',
      },
      manual_override_is_active: {
        en: 'Manual override on [[device]] !{{is|isn\'t}} active',
        pl: 'Ręczne sterowanie w [[device]] !{{jest|nie jest}} aktywne',
      },
      filter_attention: {
        en: '[[device]] filter !{{requires|doesn\'t require}} attention',
        pl: 'Filtr [[device]] !{{wymaga|nie wymaga}} uwagi',
      },
      fault_present: {
        en: '[[device]] !{{has|doesn\'t have}} a fault',
        pl: '[[device]] !{{ma|nie ma}} usterki',
      },
      defrost_active: {
        en: 'Defrost on [[device]] !{{is|isn\'t}} active',
        pl: 'Odszranianie w [[device]] !{{jest|nie jest}} aktywne',
      },
    },
    triggers: {
      mode_changed: {
        en: '[[device]] operating mode changed',
        pl: 'Zmieniono tryb pracy [[device]]',
      },
      fireplace_enabled: {
        en: 'Fireplace mode was enabled on [[device]]',
        pl: 'Włączono tryb kominka w [[device]]',
      },
      fireplace_disabled: {
        en: 'Fireplace mode was disabled on [[device]]',
        pl: 'Wyłączono tryb kominka w [[device]]',
      },
      filter_warning_appeared: {
        en: '[[device]] filter warning appeared',
        pl: 'Pojawiło się ostrzeżenie filtra [[device]]',
      },
      fault_appeared: {
        en: '[[device]] fault appeared',
        pl: 'Pojawiła się usterka [[device]]',
      },
      fault_cleared: {
        en: '[[device]] fault was cleared',
        pl: 'Usterka [[device]] została usunięta',
      },
      device_became_unavailable: {
        en: '[[device]] became unavailable',
        pl: '[[device]] stało się niedostępne',
      },
      device_became_available: {
        en: '[[device]] became available',
        pl: '[[device]] stało się dostępne',
      },
    },
  };

  for (const [type, cards] of Object.entries(expectedTitles)) {
    for (const [id, title] of Object.entries(cards)) {
      const card = readFlow(type, id);
      assert.equal(typeof card.titleFormatted.en, 'string', `${type}/${id}`);
      assert.equal(typeof card.titleFormatted.pl, 'string', `${type}/${id}`);
      assert.equal(card.title.en.includes('[[device]]'), false, `${type}/${id}`);
      assert.equal(card.title.pl.includes('[[device]]'), false, `${type}/${id}`);
      assert.equal(card.titleFormatted.en.includes('[[device]]'), false, `${type}/${id}`);
      assert.equal(card.titleFormatted.pl.includes('[[device]]'), false, `${type}/${id}`);
    }
  }

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
    ['alarm_filter', true],
    ['alarm_generic', true],
    ['alarm_defrost', true],
  ]);
  return {
    calls,
    getCapabilityValue(capability) {
      return values.get(capability);
    },
    async setOperatingMode(mode, duration) {
      calls.push(['setOperatingMode', mode, duration]);
      return true;
    },
    async setFireplace(enabled, minutes) {
      calls.push(['setFireplace', enabled, minutes]);
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
  await actions.get('enable_fireplace_for_minutes').listeners[0]({ device, minutes: 5 });
  await actions.get('refresh_state').listeners[0]({ device });
  assert.deepEqual(device.calls, [
    ['setOperatingMode', 'auto', { type: 'schedule' }],
    ['setOperatingMode', 'guests', { type: 'permanent' }],
    ['setOperatingMode', 'high', { type: 'minutes', minutes: 30 }],
    ['setFireplace', true, 5],
    ['refreshState', { force: true }],
  ]);

  assert.equal(await conditions.get('mode_is').listeners[0]({ device, mode: 'high' }), true);
  assert.equal(await conditions.get('fireplace_is_active').listeners[0]({ device }), true);
  assert.equal(await conditions.get('manual_override_is_active').listeners[0]({ device }), true);
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
