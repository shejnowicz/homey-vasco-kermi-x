const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createManagedSession,
  effectiveFireplaceState,
  parseStoredSession,
  remainingMinutes,
  restorationRequest,
  stoppedSession,
} = require('../../lib/vasco-fireplace-session');

const NOW_MS = 1_700_000_000_000;

test('createManagedSession stores only the versioned non-sensitive snapshot for a supported picker duration', () => {
  const session = createManagedSession({
    requestedMode: 4,
    controlMode: 'manual',
    manualSettingActiveTill: -1,
    email: 'owner@example.invalid',
    password: 'secret',
    bridgeId: 'bridge-123',
    raw: { fireplaceModeStatus: 0 },
  }, 45, NOW_MS);

  assert.deepEqual(session, {
    version: 1,
    priorMode: 'auto',
    priorDuration: { type: 'permanent' },
    selectedMinutes: 45,
    startedAt: NOW_MS,
    endsAt: 1_700_002_700_000,
  });
  assert.deepEqual(Object.keys(session).sort(), [
    'endsAt',
    'priorDuration',
    'priorMode',
    'selectedMinutes',
    'startedAt',
    'version',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(session)), session);
});

test('createManagedSession captures schedule and timed control semantics', () => {
  const schedule = createManagedSession({
    mode: 3,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
  }, 5, NOW_MS);
  const timed = createManagedSession({
    mode: 7,
    controlMode: 'manual',
    manualSettingActiveTill: NOW_MS + (23 * 60_000),
  }, 10, NOW_MS);
  const expired = createManagedSession({
    mode: 1,
    controlMode: 'manual',
    manualSettingActiveTill: NOW_MS - 1,
  }, 15, NOW_MS);

  assert.deepEqual(schedule.priorDuration, { type: 'schedule' });
  assert.deepEqual(timed.priorDuration, {
    type: 'minutes',
    endsAt: 1_700_001_380_000,
  });
  assert.deepEqual(expired.priorDuration, { type: 'schedule' });
});

test('createManagedSession rejects unsupported durations and malformed mode snapshots', () => {
  const state = { mode: 4, controlMode: 'schedule', manualSettingActiveTill: 0 };

  for (const minutes of [0, 1, 6, 85.5, 90, Number.NaN]) {
    assert.throws(() => createManagedSession(state, minutes, NOW_MS), RangeError);
  }
  assert.throws(() => createManagedSession({ ...state, mode: 5 }, 5, NOW_MS), RangeError);
  assert.throws(() => createManagedSession(state, 5, Number.NaN), TypeError);
});

test('parseStoredSession rejects malformed or sensitive persisted data and expired managed sessions', () => {
  const active = {
    version: 1,
    priorMode: 'auto',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };

  assert.deepEqual(parseStoredSession(JSON.stringify(active), NOW_MS + 1), active);
  assert.equal(parseStoredSession(JSON.stringify(active), active.endsAt), null);
  assert.equal(parseStoredSession(JSON.stringify({ ...active, token: 'secret' }), NOW_MS + 1), null);
  assert.equal(parseStoredSession(JSON.stringify({ ...active, priorMode: 'controller' }), NOW_MS + 1), null);
  assert.equal(parseStoredSession('{broken', NOW_MS + 1), null);
  assert.equal(parseStoredSession(null, NOW_MS + 1), null);
});

test('remainingMinutes rounds up literal milliseconds and clamps at zero', () => {
  const session = {
    version: 1,
    priorMode: 'auto',
    priorDuration: { type: 'schedule' },
    selectedMinutes: 5,
    startedAt: NOW_MS,
    endsAt: NOW_MS + (5 * 60_000),
  };

  assert.equal(remainingMinutes(session, NOW_MS + 1), 5);
  assert.equal(remainingMinutes(session, NOW_MS + (4 * 60_000) + 1), 1);
  assert.equal(remainingMinutes(session, session.endsAt), 0);
  assert.equal(remainingMinutes(session, session.endsAt + 1), 0);
});

test('restorationRequest restores permanent and schedule control semantics', () => {
  const permanent = createManagedSession({
    mode: 3,
    controlMode: 'manual',
    manualSettingActiveTill: -1,
  }, 5, NOW_MS);
  const schedule = createManagedSession({
    mode: 4,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
  }, 5, NOW_MS);

  assert.deepEqual(restorationRequest(permanent, NOW_MS), {
    mode: 'high',
    duration: { type: 'permanent' },
  });
  assert.deepEqual(restorationRequest(schedule, NOW_MS), {
    mode: 'auto',
    duration: { type: 'schedule' },
  });
});

test('restorationRequest restores an active timed override for rounded-up whole minutes', () => {
  const session = createManagedSession({
    mode: 7,
    controlMode: 'manual',
    manualSettingActiveTill: NOW_MS + (3 * 60_000) + 1,
  }, 5, NOW_MS);

  assert.deepEqual(restorationRequest(session, NOW_MS + 1), {
    mode: 'guests',
    duration: { type: 'minutes', minutes: 3 },
    nowMs: NOW_MS + 1,
  });
  assert.deepEqual(restorationRequest(session, NOW_MS + (3 * 60_000)), {
    mode: 'guests',
    duration: { type: 'minutes', minutes: 1 },
    nowMs: NOW_MS + (3 * 60_000),
  });
});

test('restorationRequest returns schedule when the prior timed override has expired', () => {
  const session = createManagedSession({
    mode: 1,
    controlMode: 'manual',
    manualSettingActiveTill: NOW_MS + 1,
  }, 5, NOW_MS);

  assert.deepEqual(restorationRequest(session, NOW_MS + 1), {
    mode: 'low',
    duration: { type: 'schedule' },
  });
});

test('stoppedSession keeps the original session deadline as the suppression deadline', () => {
  const active = createManagedSession({
    mode: 4,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
  }, 10, NOW_MS);

  assert.deepEqual(stoppedSession(active), {
    ...active,
    suppressUntil: NOW_MS + (10 * 60_000),
  });
});

test('effectiveFireplaceState suppresses stale active status only before the original deadline', () => {
  const active = createManagedSession({
    mode: 4,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
  }, 5, NOW_MS);
  const stopped = stoppedSession(active);

  assert.equal(effectiveFireplaceState(true, stopped, NOW_MS + 1), false);
  assert.equal(effectiveFireplaceState(false, stopped, NOW_MS + 1), false);
  assert.equal(effectiveFireplaceState(null, stopped, NOW_MS + 1), null);
  assert.equal(effectiveFireplaceState(true, stopped, active.endsAt), true);
});

test('parseStoredSession retains a valid stopped suppression window but rejects malformed stop metadata', () => {
  const active = createManagedSession({
    mode: 4,
    controlMode: 'schedule',
    manualSettingActiveTill: 0,
  }, 5, NOW_MS);
  const stopped = stoppedSession(active);

  assert.deepEqual(parseStoredSession(stopped, NOW_MS + 1), stopped);
  assert.equal(parseStoredSession({ ...stopped, suppressUntil: stopped.endsAt - 1 }, NOW_MS + 1), null);
  assert.equal(parseStoredSession({ ...stopped, stoppedAt: 'not-a-timestamp' }, NOW_MS + 1), null);
  assert.equal(parseStoredSession({ ...active, stoppedAt: NOW_MS + 1 }, NOW_MS + 1), null);
});
