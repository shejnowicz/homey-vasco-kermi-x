'use strict';

// TEMPORARY DIAGNOSTIC (remove after the mode-field question is settled)

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MASK,
  MAX_ENTRIES,
  RAW_PAYLOAD_SETTINGS_KEY,
  captureRawPayload,
  redactRawPayload,
  resetRawDiagnostics,
} = require('../../lib/vasco-raw-diagnostics');

function createSettings() {
  const store = new Map();
  return {
    writes: [],
    get(key) {
      return store.has(key) ? clone(store.get(key)) : null;
    },
    set(key, value) {
      this.writes.push(key);
      store.set(key, clone(value));
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('redaction masks credential-like keys and keeps the numbers we need', () => {
  const redacted = redactRawPayload({
    password: 'synthetic-secret',
    userToken: 'synthetic-token',
    macAddress: '00:11:22:33:44:55',
    serial: 'X500-0001',
    level: 4,
    requestedLevel: null,
    indoorTemperature: 21.4,
    controlMode: 'schedule',
    filterDirty: false,
    manualSettingActiveTill: 0,
  });

  assert.equal(redacted.password, MASK);
  assert.equal(redacted.userToken, MASK);
  assert.equal(redacted.macAddress, MASK);
  assert.equal(redacted.serial, MASK);
  assert.equal(redacted.level, 4);
  assert.equal(redacted.requestedLevel, null);
  assert.equal(redacted.indoorTemperature, 21.4);
  assert.equal(redacted.controlMode, 'schedule');
  assert.equal(redacted.filterDirty, false);
  assert.equal(redacted.manualSettingActiveTill, 0);
  assert.doesNotMatch(JSON.stringify(redacted), /synthetic-secret|synthetic-token/);
});

test('redaction masks e-mail values and over-long strings anywhere in the payload', () => {
  const redacted = redactRawPayload({
    owner: 'someone@example.invalid',
    note: 'x'.repeat(81),
    shortNote: 'x'.repeat(80),
    product: 'Vasco X500',
  });

  assert.equal(redacted.owner, MASK);
  assert.equal(redacted.note, MASK);
  assert.equal(redacted.shortNote, 'x'.repeat(80));
  assert.equal(redacted.product, 'Vasco X500');
  assert.doesNotMatch(JSON.stringify(redacted), /example\.invalid/);
});

test('redaction walks nested objects and arrays', () => {
  const redacted = redactRawPayload({
    gateway: {
      macAddress: '00:11:22:33:44:55',
      firmware: { swVersion: '1.2.3', build: 7 },
    },
    schedule: [
      { level: 1, active: true },
      { level: 2, contactMail: 'someone@example.invalid' },
      [3, false, 'ok'],
    ],
  });

  assert.equal(redacted.gateway.macAddress, MASK);
  assert.deepEqual(redacted.gateway.firmware, { swVersion: '1.2.3', build: 7 });
  assert.deepEqual(redacted.schedule[0], { level: 1, active: true });
  assert.equal(redacted.schedule[1].level, 2);
  assert.equal(redacted.schedule[1].contactMail, MASK);
  assert.deepEqual(redacted.schedule[2], [3, false, 'ok']);
});

test('redaction survives cycles and non-serializable values', () => {
  const raw = { level: 4, broken: Number.NaN, missing: undefined, run: () => {} };
  raw.self = raw;

  const redacted = redactRawPayload(raw);

  assert.equal(redacted.level, 4);
  assert.equal(redacted.broken, null);
  assert.equal(redacted.missing, null);
  assert.equal(redacted.run, null);
  assert.equal(redacted.self, MASK);
});

test('a capture stores a redacted ring-buffer entry in the app settings', () => {
  resetRawDiagnostics();
  const settings = createSettings();

  assert.equal(captureRawPayload('poll', { level: 4, password: 'synthetic' }, settings), true);

  const entries = settings.get(RAW_PAYLOAD_SETTINGS_KEY);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['at', 'raw', 'source']);
  assert.equal(entries[0].source, 'poll');
  assert.match(entries[0].at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.deepEqual(entries[0].raw, { level: 4, password: MASK });
});

test('an unchanged payload is not written again and the newest entry stays', () => {
  resetRawDiagnostics();
  const settings = createSettings();

  assert.equal(captureRawPayload('poll', { level: 4 }, settings), true);
  assert.equal(captureRawPayload('poll', { level: 4 }, settings), false);
  assert.equal(captureRawPayload('poll', { level: 5 }, settings), true);

  const entries = settings.get(RAW_PAYLOAD_SETTINGS_KEY);
  assert.equal(settings.writes.length, 2);
  assert.deepEqual(entries.map(entry => entry.raw.level), [4, 5]);
});

test('the ring buffer keeps the newest entries last and never grows past the cap', () => {
  resetRawDiagnostics();
  const settings = createSettings();

  for (let level = 0; level < MAX_ENTRIES + 4; level += 1) {
    captureRawPayload('poll', { level }, settings);
  }

  const entries = settings.get(RAW_PAYLOAD_SETTINGS_KEY);
  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(entries[0].raw.level, 4);
  assert.equal(entries[entries.length - 1].raw.level, MAX_ENTRIES + 3);
});

test('the command path reuses the settings manager the poll path handed over', () => {
  resetRawDiagnostics();
  const settings = createSettings();

  assert.equal(captureRawPayload('command', { level: 1 }), false);
  captureRawPayload('poll', { level: 1 }, settings);
  assert.equal(captureRawPayload('command', { level: 2 }), true);

  const entries = settings.get(RAW_PAYLOAD_SETTINGS_KEY);
  assert.deepEqual(entries.map(entry => entry.source), ['poll', 'command']);
});

test('a capture never throws when the settings manager is unusable or fails', () => {
  resetRawDiagnostics();

  assert.equal(captureRawPayload('poll', { level: 4 }, null), false);
  assert.equal(captureRawPayload('poll', { level: 4 }, {}), false);
  assert.equal(captureRawPayload('poll', { level: 4 }, {
    get: () => null,
    set: () => {
      throw new Error('settings unavailable');
    },
  }), false);
});

test('a rejected asynchronous settings write is swallowed', async () => {
  resetRawDiagnostics();
  let rejected = null;

  assert.equal(captureRawPayload('poll', { level: 4 }, {
    get: () => null,
    set: () => {
      rejected = Promise.reject(new Error('settings unavailable'));
      return rejected;
    },
  }), true);

  await assert.doesNotReject(rejected.catch(() => {}));
});
