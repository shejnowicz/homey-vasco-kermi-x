'use strict';

const Module = require('node:module');
const assert = require('node:assert/strict');
const { test } = require('node:test');

function loadAppClass() {
  const appPath = require.resolve('../../app');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') return { App: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[appPath];
    return require(appPath);
  } finally {
    Module._load = originalLoad;
  }
}

test('app-owned account services use Homey lifecycle timers and are closed on uninit', async () => {
  const timers = [];
  const App = loadAppClass();
  const app = new App();
  app.log = () => {};
  app.homey = {
    setTimeout(fn, delayMs) {
      timers.push({ fn, delayMs });
      return timers.length;
    },
    clearTimeout(id) {
      timers[id - 1].cleared = true;
    },
    notifications: { createNotification: async () => undefined },
  };

  await app.onInit();
  const service = app.vascoAccountRegistry.acquire({
    email: 'runtime@example.invalid',
    password: 'synthetic-runtime-password',
  });
  service.startPolling(60, async () => {}, async () => {});

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 60_000);
  await app.onUninit();
  assert.equal(timers[0].cleared, true);
  assert.equal(app.vascoAccountRegistry, null);
});
