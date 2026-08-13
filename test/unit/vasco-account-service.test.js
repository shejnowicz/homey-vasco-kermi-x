const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('../fixtures/account-multiple-devices');
const { VascoAccountService } = require('../../lib/vasco-account-service');
const {
  VascoAuthenticationError,
  VascoProtocolError,
  VascoTransportError,
} = require('../../lib/vasco-errors');
const { discoverVentilationDevices } = require('../../lib/vasco-device-mapper');

const EMAIL = 'owner@example.invalid';
const PASSWORD = 'correct-horse-fixture';
const NEW_EMAIL = 'replacement@example.invalid';
const NEW_PASSWORD = 'replacement-horse-fixture';
const OLD_TOKEN = 'fixture-old-token';
const NEW_TOKEN = 'fixture-new-token';
const [KITCHEN, BEDROOM] = discoverVentilationDevices(fixture);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

async function advanceNextTimer(clock) {
  for (let attempt = 0; attempt < 8 && clock.nextDelay() === null; attempt += 1) {
    await settle();
  }
  const delay = clock.nextDelay();
  assert.notEqual(delay, null, 'expected a scheduled timer');
  clock.advance(delay);
}

class FakeClock {
  constructor(nowMs = 1_725_000_000_000) {
    this.nowMs = nowMs;
    this.nextId = 1;
    this.timers = new Map();
  }

  now() {
    return this.nowMs;
  }

  setTimeout(fn, delayMs) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + delayMs, fn });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  advance(delayMs) {
    const target = this.nowMs + delayMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;

      const [id, timer] = due;
      this.timers.delete(id);
      this.nowMs = timer.at;
      timer.fn();
    }
    this.nowMs = target;
  }

  nextDelay() {
    if (this.timers.size === 0) return null;
    return Math.min(...[...this.timers.values()].map(timer => timer.at - this.nowMs));
  }
}

function createService(apiClient, options = {}) {
  return new VascoAccountService({
    apiClient,
    email: EMAIL,
    password: PASSWORD,
    clock: options.clock ?? new FakeClock(),
    notify: options.notify ?? (() => {}),
  });
}

function configurationWithRequestedLevels(kitchenLevel, bedroomLevel = 4) {
  return {
    ...fixture,
    deviceProperties: fixture.deviceProperties.map(device => {
      if (device.deviceId === KITCHEN.deviceRef) {
        return { ...device, requestedLevel: kitchenLevel };
      }
      if (device.deviceId === BEDROOM.deviceRef) {
        return { ...device, requestedLevel: bedroomLevel };
      }
      return device;
    }),
  };
}

test('simultaneous configuration reads share one login and one request without caching the completed result', async () => {
  const firstRead = deferred();
  let loginCalls = 0;
  let readCalls = 0;
  const apiClient = {
    login: async () => {
      loginCalls += 1;
      return OLD_TOKEN;
    },
    getAccountConfiguration: async () => {
      readCalls += 1;
      return readCalls === 1 ? firstRead.promise : fixture;
    },
  };
  const service = createService(apiClient);

  const left = service.readConfiguration();
  const right = service.readConfiguration();
  await settle();

  assert.equal(loginCalls, 1);
  assert.equal(readCalls, 1);
  firstRead.resolve(fixture);
  assert.equal(await left, fixture);
  assert.equal(await right, fixture);

  assert.equal(await service.readConfiguration(), fixture);
  assert.equal(loginCalls, 1);
  assert.equal(readCalls, 2);
});

test('forced reads queue one new generation behind an older read and coalesce only before that generation starts', async () => {
  const reads = [deferred(), deferred(), deferred()];
  let readCalls = 0;
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => {
      const current = reads[readCalls];
      readCalls += 1;
      return current.promise;
    },
  };
  const service = createService(apiClient);

  const ordinary = service.readConfiguration();
  await settle();
  const forcedLeft = service.readConfiguration({ force: true });
  const forcedRight = service.readConfiguration({ force: true });
  assert.equal(readCalls, 1);

  reads[0].resolve({ generation: 1 });
  await settle();
  assert.equal(readCalls, 2);

  const forcedAfterStart = service.readConfiguration({ force: true });
  assert.equal(readCalls, 2);
  reads[1].resolve({ generation: 2 });
  await settle();
  assert.equal(readCalls, 3);
  reads[2].resolve({ generation: 3 });

  assert.deepEqual(await ordinary, { generation: 1 });
  assert.deepEqual(await forcedLeft, { generation: 2 });
  assert.deepEqual(await forcedRight, { generation: 2 });
  assert.deepEqual(await forcedAfterStart, { generation: 3 });
});

test('simultaneous expired-token operations share one reauthentication and replay each operation once', async () => {
  let loginCalls = 0;
  const writes = [];
  const notifications = [];
  const apiClient = {
    login: async () => {
      loginCalls += 1;
      return loginCalls === 1 ? OLD_TOKEN : NEW_TOKEN;
    },
    getAccountConfiguration: async () => fixture,
    setDeviceProperties: async (token, [device]) => {
      writes.push({ token, deviceId: device.deviceId });
      if (token === OLD_TOKEN) throw new VascoAuthenticationError('expired token');
      return { accepted: true };
    },
  };
  const service = createService(apiClient, { notify: notification => notifications.push(notification) });
  await service.readConfiguration();

  const build = raw => ({ ...raw, requestedLevel: raw.requestedLevel + 1 });
  const [kitchenState, bedroomState] = await Promise.all([
    service.executeDeviceCommand(KITCHEN.identity, build, () => true),
    service.executeDeviceCommand(BEDROOM.identity, build, () => true),
  ]);

  assert.equal(loginCalls, 2);
  assert.equal(writes.length, 4);
  assert.deepEqual(writes.map(write => write.token).sort(), [NEW_TOKEN, NEW_TOKEN, OLD_TOKEN, OLD_TOKEN].sort());
  assert.equal(notifications.length, 0);
  assert.equal(kitchenState.product, 'Vasco X500');
  assert.equal(bedroomState.product, 'Kermi X350');
});

test('staggered failures from one expired session reuse its completed reauthentication outcome', async () => {
  const oldWrites = new Map([
    [KITCHEN.deviceRef, deferred()],
    [BEDROOM.deviceRef, deferred()],
  ]);
  const bothOldWritesEntered = deferred();
  const kitchenReplayEntered = deferred();
  const kitchenReplay = deferred();
  const writes = [];
  let oldWriteCalls = 0;
  let loginCalls = 0;
  const apiClient = {
    login: async () => {
      loginCalls += 1;
      return [OLD_TOKEN, NEW_TOKEN, 'unexpected-third-token'][loginCalls - 1];
    },
    getAccountConfiguration: async () => fixture,
    setDeviceProperties: async (token, [device]) => {
      writes.push({ token, deviceId: device.deviceId });
      if (token === OLD_TOKEN) {
        oldWriteCalls += 1;
        if (oldWriteCalls === 2) bothOldWritesEntered.resolve();
        return oldWrites.get(device.deviceId).promise;
      }
      if (token === NEW_TOKEN && device.deviceId === KITCHEN.deviceRef) {
        kitchenReplayEntered.resolve();
        return kitchenReplay.promise;
      }
      if (token === NEW_TOKEN) {
        throw new VascoAuthenticationError('shared replay token also rejected');
      }
      return { accepted: true };
    },
  };
  const service = createService(apiClient);
  await service.readConfiguration();

  const kitchen = service.executeDeviceCommand(KITCHEN.identity, raw => ({ ...raw }), () => true);
  const bedroom = service.executeDeviceCommand(BEDROOM.identity, raw => ({ ...raw }), () => true);
  await bothOldWritesEntered.promise;

  oldWrites.get(KITCHEN.deviceRef).reject(new VascoAuthenticationError('expired old session'));
  await kitchenReplayEntered.promise;
  kitchenReplay.reject(new VascoAuthenticationError('replay also rejected'));
  await assert.rejects(() => kitchen, VascoAuthenticationError);

  oldWrites.get(BEDROOM.deviceRef).reject(new VascoAuthenticationError('same expired old session'));
  await assert.rejects(() => bedroom, VascoAuthenticationError);

  assert.equal(loginCalls, 2);
  assert.ok(writes.some(write => write.deviceId === BEDROOM.deviceRef && write.token === NEW_TOKEN));
  assert.ok(!writes.some(write => write.token === 'unexpected-third-token'));
});

test('an operation rejected again after reauthentication is not replayed a second time', async () => {
  let loginCalls = 0;
  let readCalls = 0;
  const notifications = [];
  const apiClient = {
    login: async () => {
      loginCalls += 1;
      return loginCalls === 1 ? OLD_TOKEN : NEW_TOKEN;
    },
    getAccountConfiguration: async () => {
      readCalls += 1;
      if (readCalls === 1) return fixture;
      throw new VascoAuthenticationError(`${PASSWORD} must never escape`);
    },
  };
  const service = createService(apiClient, { notify: notification => notifications.push(notification) });
  await service.readConfiguration();

  await assert.rejects(
    () => service.readConfiguration(),
    (error) => error instanceof VascoAuthenticationError
      && !error.message.includes(PASSWORD),
  );

  assert.equal(loginCalls, 2);
  assert.equal(readCalls, 3);
  assert.equal(notifications.length, 1);
  assert.doesNotMatch(String(notifications[0]?.message ?? notifications[0]), new RegExp(PASSWORD));
});

test('commands for the same identity are serialized through confirmation', async () => {
  const firstWrite = deferred();
  const firstWriteEntered = deferred();
  let writeCalls = 0;
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => fixture,
    setDeviceProperties: async () => {
      writeCalls += 1;
      firstWriteEntered.resolve();
      if (writeCalls === 1) await firstWrite.promise;
      return { accepted: true };
    },
  };
  const service = createService(apiClient);

  const first = service.executeDeviceCommand(KITCHEN.identity, raw => ({ ...raw, requestedLevel: 2 }), () => true);
  const second = service.executeDeviceCommand(KITCHEN.identity, raw => ({ ...raw, requestedLevel: 3 }), () => true);
  await firstWriteEntered.promise;
  assert.equal(writeCalls, 1);

  firstWrite.resolve();
  await first;
  await settle();
  assert.equal(writeCalls, 2);
  await second;
});

test('commands for different identities can write in parallel', async () => {
  const writes = [deferred(), deferred()];
  const bothWritesEntered = deferred();
  let writeCalls = 0;
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => fixture,
    setDeviceProperties: async () => {
      const current = writes[writeCalls];
      writeCalls += 1;
      if (writeCalls === 2) bothWritesEntered.resolve();
      await current.promise;
      return { accepted: true };
    },
  };
  const service = createService(apiClient);

  const kitchen = service.executeDeviceCommand(KITCHEN.identity, raw => ({ ...raw }), () => true);
  const bedroom = service.executeDeviceCommand(BEDROOM.identity, raw => ({ ...raw }), () => true);
  await bothWritesEntered.promise;
  assert.equal(writeCalls, 2);

  writes[0].resolve();
  writes[1].resolve();
  await Promise.all([kitchen, bedroom]);
});

test('a command returns mapped confirmed state and rejects an unconfirmed state', async () => {
  let reads = 0;
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => {
      reads += 1;
      return reads === 1
        ? configurationWithRequestedLevels(2)
        : configurationWithRequestedLevels(4);
    },
    setDeviceProperties: async () => ({ accepted: true }),
  };
  const service = createService(apiClient);

  const state = await service.executeDeviceCommand(
    KITCHEN.identity,
    raw => ({ ...raw, requestedLevel: 4 }),
    observed => observed.requestedMode === 4,
  );
  assert.equal(state.requestedMode, 4);

  const rejection = service.executeDeviceCommand(
    KITCHEN.identity,
    raw => ({ ...raw }),
    () => false,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await advanceNextTimer(service.clock);
  }
  await assert.rejects(rejection, VascoProtocolError);
});

test('command confirmation retries while the Vasco cloud still returns stale state', async () => {
  const clock = new FakeClock();
  let reads = 0;
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => {
      reads += 1;
      return reads < 4
        ? configurationWithRequestedLevels(2)
        : configurationWithRequestedLevels(4);
    },
    setDeviceProperties: async () => ({ accepted: true }),
  };
  const service = createService(apiClient, { clock });

  const command = service.executeDeviceCommand(
    KITCHEN.identity,
    raw => ({ ...raw, nextParameter: 'requestedLevel', nextValue: 4 }),
    observed => observed.requestedMode === 4,
  );
  await advanceNextTimer(clock);
  await advanceNextTimer(clock);

  assert.equal((await command).requestedMode, 4);
  assert.equal(reads, 4);
});

test('mode command writes the shifted requested level through the Vasco WebSocket', async () => {
  const physicalWrites = [];
  const configuration = {
    ...fixture,
    bridges: [{
      macAddress: 'fixture-bridge',
      appServerURL: 'https://appserver.example.invalid/',
      bridgeToken: 'fixture-bridge-token',
    }],
  };
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => configuration,
    setDeviceProperties: async () => ({}),
    writeDeviceParameter: async options => physicalWrites.push(options),
  };
  const service = createService(apiClient);

  await service.executeDeviceCommand(
    KITCHEN.identity,
    raw => ({
      ...raw,
      nextParameter: 'requestedLevel',
      nextValue: 3,
    }),
    () => true,
  );

  assert.equal(physicalWrites.length, 1);
  assert.equal(physicalWrites[0].userToken, OLD_TOKEN);
  assert.equal(physicalWrites[0].configuration, configuration);
  assert.equal(physicalWrites[0].parameterName, 'requestedLevel');
  assert.equal(physicalWrites[0].value, 4);
  assert.equal(physicalWrites[0].expectedFunctionName, 'dataWritten');
  assert.equal(physicalWrites[0].expectedParameter, 'requestedLevel');
  assert.equal(physicalWrites[0].expectedValue, 4);
});

test('holiday and guest modes keep their unshifted Vasco WebSocket codes', async () => {
  const physicalWrites = [];
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => fixture,
    setDeviceProperties: async () => ({}),
    writeDeviceParameter: async options => physicalWrites.push(options),
  };
  const service = createService(apiClient);

  for (const value of [6, 7]) {
    await service.executeDeviceCommand(
      KITCHEN.identity,
      raw => ({ ...raw, nextParameter: 'requestedLevel', nextValue: value }),
      () => true,
    );
  }

  assert.deepEqual(physicalWrites.map(write => write.value), [6, 7]);
});

test('WebSocket acknowledgement returns the requested mode before REST catches up', async () => {
  const writeAcknowledged = deferred();
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => fixture,
    setDeviceProperties: async () => ({}),
    writeDeviceParameter: async () => writeAcknowledged.resolve(),
  };
  const service = createService(apiClient);

  const command = service.executeDeviceCommand(
    KITCHEN.identity,
    raw => ({
      ...raw,
      requestedLevel: undefined,
      nextParameter: 'requestedLevel',
      nextValue: 4,
      manualSettingActiveTill: -1,
    }),
    observed => observed.mode === 4 && observed.manualSettingActiveTill === -1,
  );
  await writeAcknowledged.promise;
  await settle();
  assert.equal(service.clock.nextDelay(), null);
  const state = await command;

  assert.equal(state.mode, 4);
  assert.equal(state.manualSettingActiveTill, -1);
});

test('polling waits for the configured interval, does not overlap, and reports availability only on transitions', async () => {
  const clock = new FakeClock();
  const slowRead = deferred();
  let readCalls = 0;
  const states = [];
  const availability = [];
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => {
      readCalls += 1;
      return readCalls === 1 ? slowRead.promise : fixture;
    },
  };
  const service = createService(apiClient, { clock });

  service.startPolling(60, state => states.push(state), available => availability.push(available));
  clock.advance(59_999);
  await settle();
  assert.equal(readCalls, 0);
  clock.advance(1);
  await settle();
  assert.equal(readCalls, 1);

  clock.advance(300_000);
  await settle();
  assert.equal(readCalls, 1);
  slowRead.resolve(fixture);
  await settle();
  assert.equal(clock.nextDelay(), 60_000);
  assert.deepEqual(states, [fixture]);
  assert.deepEqual(availability, [true]);

  clock.advance(60_000);
  await settle();
  assert.equal(readCalls, 2);
  assert.deepEqual(availability, [true]);
  service.stopPolling();
});

test('poll failures back off 30s, 60s, and 120s, become unavailable at three, then reset after success', async () => {
  const clock = new FakeClock();
  const outcomes = [
    new VascoTransportError('offline one'),
    new VascoTransportError('offline two'),
    new VascoTransportError('offline three'),
    fixture,
    new VascoTransportError('offline after recovery'),
  ];
  const availability = [];
  let readCalls = 0;
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => {
      const outcome = outcomes[readCalls];
      readCalls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  const service = createService(apiClient, { clock });
  service.startPolling(10, () => {}, (available, error) => availability.push({ available, error }));

  clock.advance(10_000);
  await settle();
  assert.equal(clock.nextDelay(), 30_000);
  clock.advance(30_000);
  await settle();
  assert.equal(clock.nextDelay(), 60_000);
  clock.advance(60_000);
  await settle();
  assert.equal(clock.nextDelay(), 120_000);
  assert.equal(availability.length, 1);
  assert.equal(availability[0].available, false);
  assert.ok(availability[0].error instanceof VascoTransportError);

  clock.advance(120_000);
  await settle();
  assert.equal(clock.nextDelay(), 10_000);
  assert.deepEqual(availability.map(entry => entry.available), [false, true]);

  clock.advance(10_000);
  await settle();
  assert.equal(clock.nextDelay(), 30_000);
  assert.deepEqual(availability.map(entry => entry.available), [false, true]);
  service.stopPolling();
});

test('poll failure backoff is capped at 30 minutes', async () => {
  const clock = new FakeClock();
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => {
      throw new VascoTransportError('offline');
    },
  };
  const service = createService(apiClient, { clock });
  service.startPolling(10, () => {}, () => {});

  clock.advance(10_000);
  await settle();
  for (const expectedSeconds of [30, 60, 120, 240, 480, 960, 1800, 1800]) {
    assert.equal(clock.nextDelay(), expectedSeconds * 1_000);
    clock.advance(expectedSeconds * 1_000);
    await settle();
  }
  assert.equal(clock.nextDelay(), 1_800_000);
  service.stopPolling();
});

test('authentication polling failures become unavailable immediately and emit one redacted notification', async () => {
  const clock = new FakeClock();
  const notifications = [];
  const availability = [];
  const apiClient = {
    login: async () => {
      throw new VascoAuthenticationError(`${PASSWORD} rejected`);
    },
    getAccountConfiguration: async () => fixture,
  };
  const service = createService(apiClient, {
    clock,
    notify: notification => notifications.push(notification),
  });
  service.startPolling(10, () => {}, (available, error) => availability.push({ available, error }));

  clock.advance(10_000);
  await settle();
  assert.equal(clock.nextDelay(), 30_000);
  clock.advance(30_000);
  await settle();

  assert.equal(notifications.length, 1);
  assert.equal(availability.length, 1);
  assert.equal(availability[0].available, false);
  assert.ok(availability[0].error instanceof VascoAuthenticationError);
  assert.doesNotMatch(availability[0].error.message, new RegExp(PASSWORD));
  assert.doesNotMatch(String(notifications[0]?.message ?? notifications[0]), new RegExp(PASSWORD));
  service.stopPolling();
});

test('direct authentication failures suppress immediate relogin until backoff and credential replacement resets it', async () => {
  const clock = new FakeClock();
  let loginCalls = 0;
  const apiClient = {
    login: async email => {
      loginCalls += 1;
      if (email === NEW_EMAIL) return NEW_TOKEN;
      throw new VascoAuthenticationError('credentials rejected');
    },
    getAccountConfiguration: async () => fixture,
  };
  const service = createService(apiClient, { clock });

  await assert.rejects(() => service.readConfiguration(), VascoAuthenticationError);
  await assert.rejects(() => service.readConfiguration(), VascoAuthenticationError);
  assert.equal(loginCalls, 1);

  clock.advance(29_999);
  await assert.rejects(() => service.readConfiguration(), VascoAuthenticationError);
  assert.equal(loginCalls, 1);
  clock.advance(1);
  await assert.rejects(() => service.readConfiguration(), VascoAuthenticationError);
  assert.equal(loginCalls, 2);

  await service.updateCredentials(NEW_EMAIL, NEW_PASSWORD);
  assert.equal(await service.readConfiguration(), fixture);
  assert.equal(loginCalls, 3);
});

test('stopPolling clears scheduled work and suppresses completion from an in-flight poll', async () => {
  const clock = new FakeClock();
  const read = deferred();
  const states = [];
  let readCalls = 0;
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => {
      readCalls += 1;
      return read.promise;
    },
  };
  const service = createService(apiClient, { clock });

  service.startPolling(10, state => states.push(state), () => {});
  service.stopPolling();
  clock.advance(10_000);
  await settle();
  assert.equal(readCalls, 0);

  service.startPolling(10, state => states.push(state), () => {});
  clock.advance(10_000);
  await settle();
  assert.equal(readCalls, 1);
  service.stopPolling();
  read.resolve(fixture);
  await settle();

  assert.deepEqual(states, []);
  assert.equal(clock.nextDelay(), null);
});

test('successful credential replacement validates first and atomically installs the new session', async () => {
  const logins = [];
  const readTokens = [];
  const apiClient = {
    login: async (email, password) => {
      logins.push({ email, password });
      return email === NEW_EMAIL ? NEW_TOKEN : OLD_TOKEN;
    },
    getAccountConfiguration: async token => {
      readTokens.push(token);
      return fixture;
    },
  };
  const service = createService(apiClient);
  await service.readConfiguration();

  await service.updateCredentials(NEW_EMAIL, NEW_PASSWORD);
  await service.readConfiguration();

  assert.deepEqual(logins, [
    { email: EMAIL, password: PASSWORD },
    { email: NEW_EMAIL, password: NEW_PASSWORD },
  ]);
  assert.deepEqual(readTokens, [OLD_TOKEN, NEW_TOKEN]);
});

test('credential replacement returns a disposable opaque rollback handle owned by the service', async () => {
  const logins = [];
  const readTokens = [];
  const apiClient = {
    login: async (email, password) => {
      logins.push({ email, password });
      return email === NEW_EMAIL ? NEW_TOKEN : OLD_TOKEN;
    },
    getAccountConfiguration: async token => {
      readTokens.push(token);
      return fixture;
    },
  };
  const service = createService(apiClient);
  await service.readConfiguration();

  const rollback = await service.updateCredentials(NEW_EMAIL, NEW_PASSWORD);
  assert.equal(typeof rollback.rollback, 'function');
  assert.equal(typeof rollback.discard, 'function');
  assert.doesNotMatch(JSON.stringify(rollback), new RegExp(PASSWORD));
  await rollback.rollback();
  await service.readConfiguration();

  assert.deepEqual(logins, [
    { email: EMAIL, password: PASSWORD },
    { email: NEW_EMAIL, password: NEW_PASSWORD },
    { email: EMAIL, password: PASSWORD },
  ]);
  assert.deepEqual(readTokens, [OLD_TOKEN, OLD_TOKEN]);
});

test('credential replacement supersedes a stale in-flight login failure without a false notification', async () => {
  const oldLogin = deferred();
  const oldLoginEntered = deferred();
  const notifications = [];
  const readTokens = [];
  const apiClient = {
    login: async email => {
      if (email === EMAIL) {
        oldLoginEntered.resolve();
        return oldLogin.promise;
      }
      return NEW_TOKEN;
    },
    getAccountConfiguration: async token => {
      readTokens.push(token);
      return fixture;
    },
  };
  const service = createService(apiClient, { notify: notification => notifications.push(notification) });

  const staleRead = service.readConfiguration();
  await oldLoginEntered.promise;
  await service.updateCredentials(NEW_EMAIL, NEW_PASSWORD);
  oldLogin.reject(new VascoAuthenticationError(`${PASSWORD} rejected too late`));

  assert.equal(await staleRead, fixture);
  assert.deepEqual(readTokens, [NEW_TOKEN]);
  assert.deepEqual(notifications, []);
});

test('a read started after credential replacement does not coalesce onto an old-account read', async () => {
  const oldRead = deferred();
  const oldReadEntered = deferred();
  const oldConfiguration = { account: 'old' };
  const newConfiguration = { account: 'new' };
  const readTokens = [];
  const apiClient = {
    login: async email => email === NEW_EMAIL ? NEW_TOKEN : OLD_TOKEN,
    getAccountConfiguration: async token => {
      readTokens.push(token);
      if (token === OLD_TOKEN) {
        oldReadEntered.resolve();
        return oldRead.promise;
      }
      return newConfiguration;
    },
  };
  const service = createService(apiClient);

  const beforeReplacement = service.readConfiguration();
  await oldReadEntered.promise;
  await service.updateCredentials(NEW_EMAIL, NEW_PASSWORD);
  const afterReplacement = service.readConfiguration();
  oldRead.resolve(oldConfiguration);

  assert.equal(await beforeReplacement, oldConfiguration);
  assert.equal(await afterReplacement, newConfiguration);
  assert.deepEqual(readTokens, [OLD_TOKEN, NEW_TOKEN]);
});

test('failed credential validation preserves the working credentials and session without leaking replacements', async () => {
  const logins = [];
  const readTokens = [];
  const apiClient = {
    login: async (email, password) => {
      logins.push({ email, password });
      if (email === NEW_EMAIL) {
        throw new VascoAuthenticationError(`${NEW_PASSWORD} rejected`);
      }
      return OLD_TOKEN;
    },
    getAccountConfiguration: async token => {
      readTokens.push(token);
      return fixture;
    },
  };
  const service = createService(apiClient);
  await service.readConfiguration();

  await assert.rejects(
    () => service.updateCredentials(NEW_EMAIL, NEW_PASSWORD),
    (error) => error instanceof VascoAuthenticationError
      && !error.message.includes(NEW_PASSWORD)
      && !error.message.includes(PASSWORD),
  );
  await service.readConfiguration();

  assert.deepEqual(logins, [
    { email: EMAIL, password: PASSWORD },
    { email: NEW_EMAIL, password: NEW_PASSWORD },
  ]);
  assert.deepEqual(readTokens, [OLD_TOKEN, OLD_TOKEN]);
});

test('credentials and session token are omitted from enumerable diagnostics', async () => {
  const apiClient = {
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => fixture,
  };
  const service = createService(apiClient);
  await service.readConfiguration();

  const diagnostic = JSON.stringify(service);
  assert.doesNotMatch(diagnostic, new RegExp(EMAIL));
  assert.doesNotMatch(diagnostic, new RegExp(PASSWORD));
  assert.doesNotMatch(diagnostic, new RegExp(OLD_TOKEN));
  assert.ok(!Object.keys(service).includes('email'));
  assert.ok(!Object.keys(service).includes('password'));
  assert.ok(!Object.keys(service).includes('session'));
});
