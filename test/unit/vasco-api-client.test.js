const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VascoApiClient,
} = require('../../lib/vasco-api-client');
const {
  VascoAuthenticationError,
  VascoProtocolError,
  VascoTransportError,
} = require('../../lib/vasco-errors');

const API_BASE_URL = 'https://vasco.iqloud.eu/api/';
const EMAIL = 'owner@example.invalid';
const PASSWORD = 'correct-horse-fixture';
const USER_TOKEN = 'fixture-user-token';
const fixtureDevice = {
  id: 'fixture-device-id',
  product: 'Vasco X500',
  requestedLevel: 2,
};

function successfulResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 'success', payload }),
  };
}

function requestRecorder(response) {
  const requests = [];
  return {
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      return response;
    },
    requests,
  };
}

test('uses a four-second WebSocket timeout independently of the REST timeout', () => {
  const client = new VascoApiClient({
    fetchImpl: async () => {
      throw new Error('not called');
    },
  });

  assert.equal(client.timeoutMs, 15_000);
  assert.equal(client.webSocketClient.timeoutMs, 4_000);
});

test('login serializes the Vasco nested credentials payload and returns its token', async () => {
  const { fetchImpl, requests } = requestRecorder(successfulResponse({ userToken: USER_TOKEN }));
  const client = new VascoApiClient({ fetchImpl, baseUrl: API_BASE_URL });

  const token = await client.login(EMAIL, PASSWORD);

  assert.equal(token, USER_TOKEN);
  assert.equal(requests.length, 1);
  const [loginRequest] = requests;
  assert.equal(loginRequest.url, `${API_BASE_URL}login`);
  assert.equal(loginRequest.method, 'POST');
  assert.equal(loginRequest.headers['content-type'], 'application/json');
  assert.equal(loginRequest.headers['user-agent'], 'Dart/3.8 (dart:io)');
  assert.deepEqual(JSON.parse(loginRequest.body), {
    payload: JSON.stringify({ userInfo: {
      email: 'owner@example.invalid',
      password: 'correct-horse-fixture',
    } }),
  });
});

test('getAccountConfiguration serializes the user token and returns the configuration payload', async () => {
  const configuration = { bridges: [{ id: 'fixture-bridge-id', devices: [fixtureDevice] }] };
  const { fetchImpl, requests } = requestRecorder(successfulResponse(configuration));
  const client = new VascoApiClient({ fetchImpl, baseUrl: API_BASE_URL });

  const result = await client.getAccountConfiguration(USER_TOKEN);

  assert.deepEqual(result, configuration);
  assert.equal(requests.length, 1);
  const [readRequest] = requests;
  assert.equal(readRequest.url, `${API_BASE_URL}getaccountconfiguration`);
  assert.deepEqual(JSON.parse(readRequest.body), { userToken: 'fixture-user-token' });
});

test('setDeviceProperties serializes a complete device array and returns its response payload', async () => {
  const acknowledgement = { accepted: true };
  const { fetchImpl, requests } = requestRecorder(successfulResponse(acknowledgement));
  const client = new VascoApiClient({ fetchImpl, baseUrl: API_BASE_URL });

  const result = await client.setDeviceProperties(USER_TOKEN, [fixtureDevice]);

  assert.deepEqual(result, acknowledgement);
  assert.equal(requests.length, 1);
  const [writeRequest] = requests;
  assert.equal(writeRequest.url, `${API_BASE_URL}setdeviceproperties`);
  assert.deepEqual(JSON.parse(writeRequest.body), {
    userToken: 'fixture-user-token',
    payload: JSON.stringify([fixtureDevice]),
  });
});

test('setDeviceProperties accepts the Vasco success envelope without a payload', async () => {
  const { fetchImpl } = requestRecorder({
    ok: true,
    status: 200,
    json: async () => ({ status: 'success', functionName: 'setdeviceproperties' }),
  });
  const client = new VascoApiClient({ fetchImpl, baseUrl: API_BASE_URL });

  assert.deepEqual(
    await client.setDeviceProperties(USER_TOKEN, [fixtureDevice]),
    {},
  );
});

test('delegates a physical device write to the Vasco WebSocket client', async () => {
  const writes = [];
  const webSocketClient = {
    writeParameter: async options => writes.push(options),
  };
  const client = new VascoApiClient({
    fetchImpl: async () => successfulResponse({}),
    webSocketClient,
  });
  const options = {
    userToken: USER_TOKEN,
    configuration: { bridges: [] },
    raw: fixtureDevice,
    command: { ...fixtureDevice, nextValue: 3 },
    parameterName: 'requestedLevel',
    value: 4,
    expectedParameter: 'level',
    expectedValue: 3,
  };

  await client.writeDeviceParameter(options);

  assert.deepEqual(writes, [options]);
});

test('rejects an aborted request with a typed transport error', async () => {
  const timers = [];
  const clock = {
    setTimeout(fn, delayMs) {
      timers.push({ fn, delayMs });
      return timers.length;
    },
    clearTimeout(id) {
      timers[id - 1].cleared = true;
    },
  };
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('request aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const client = new VascoApiClient({ fetchImpl, baseUrl: API_BASE_URL, timeoutMs: 1, clock });

  const request = client.getAccountConfiguration(USER_TOKEN);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1);
  timers[0].fn();

  await assert.rejects(
    () => request,
    (error) => error instanceof VascoTransportError && /get account configuration/.test(error.message),
  );
  assert.equal(timers[0].cleared, true);
});

test('rejects login authentication failures without leaking credentials or token', async () => {
  const responseBody = `${PASSWORD} ${USER_TOKEN} is rejected`;
  const { fetchImpl } = requestRecorder({
    ok: false,
    status: 401,
    json: async () => ({ status: 'error', message: responseBody }),
  });
  const client = new VascoApiClient({ fetchImpl, baseUrl: API_BASE_URL });

  await assert.rejects(
    () => client.login(EMAIL, PASSWORD),
    (error) => {
      assert.ok(error instanceof VascoAuthenticationError);
      assert.doesNotMatch(error.message, new RegExp(PASSWORD));
      assert.doesNotMatch(error.message, new RegExp(USER_TOKEN));
      assert.doesNotMatch(error.stack, new RegExp(PASSWORD));
      assert.doesNotMatch(error.stack, new RegExp(USER_TOKEN));
      return true;
    },
  );
});

test('rejects a malformed success response with a typed protocol error', async () => {
  const { fetchImpl } = requestRecorder(successfulResponse({ bridges: [] }));
  const client = new VascoApiClient({ fetchImpl, baseUrl: API_BASE_URL });

  await assert.rejects(
    () => client.login(EMAIL, PASSWORD),
    (error) => error instanceof VascoProtocolError && /login/.test(error.message),
  );
});
