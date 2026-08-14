const test = require('node:test');
const assert = require('node:assert/strict');

const { VascoWebSocketClient } = require('../../lib/vasco-websocket-client');
const {
  VascoProtocolError,
  VascoTransportError,
} = require('../../lib/vasco-errors');

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.binaryType = '';
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name, event = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

function binaryMessage(message) {
  return { data: new TextEncoder().encode(JSON.stringify(message)).buffer };
}

test('sends Vasco account sync and shifted mode code as binary WebSocket frames', async () => {
  let socket;
  const client = new VascoWebSocketClient({
    createSocket: url => {
      socket = new FakeSocket(url);
      return socket;
    },
  });
  const raw = {
    macAddress: 'fixture-bridge',
    modbusAddress: 2,
    swVersion: 26,
    productType: 'fixture-product-type',
    level: 2,
    nextParameter: 'requestedLevel',
    nextValue: 3,
  };
  const configuration = {
    bridges: [{
      macAddress: 'fixture-bridge',
      appServerURL: 'https://appserver.example.invalid/',
      bridgeToken: 'fixture-bridge-token',
    }],
  };

  const write = client.writeParameter({
    userToken: 'fixture-user-token',
    configuration,
    raw,
    command: { ...raw },
    parameterName: 'requestedLevel',
    value: 4,
    expectedFunctionName: 'dataWritten',
    expectedParameter: 'requestedLevel',
    expectedValue: 4,
  });
  socket.emit('open');
  socket.emit('message', binaryMessage({ functionName: 'connectionStatus', status: 'OK' }));
  await Promise.resolve();

  assert.equal(socket.binaryType, 'arraybuffer');
  assert.equal(socket.sent.length, 2);
  assert.ok(socket.sent.every(frame => frame instanceof Uint8Array));
  const [sync, command] = socket.sent.map(frame => JSON.parse(new TextDecoder().decode(frame)));
  assert.deepEqual(sync, {
    functionName: 'accountPropertiesChanged',
    itemName: 'deviceProperties',
    mustSyncOtherApps: true,
    payload: JSON.stringify([{ ...raw }]),
  });
  assert.deepEqual(command, {
    functionName: 'writeData',
    parameterName: 'requestedLevel',
    data: 4,
    modbusAddress: 2,
    swVersion: 26,
    productType: 'fixture-product-type',
  });

  socket.emit('message', binaryMessage({
    functionName: 'dataWritten',
    parameterName: 'requestedLevel',
    value: 4,
  }));
  await write;
  assert.equal(socket.closed, true);
});

test('sends Fireplace account sync and unshifted fireplaceModeTime as binary WebSocket frames', async () => {
  let socket;
  const client = new VascoWebSocketClient({
    createSocket: url => {
      socket = new FakeSocket(url);
      return socket;
    },
  });
  const raw = {
    macAddress: 'fixture-bridge',
    modbusAddress: 2,
    swVersion: 26,
    productType: 'fixture-product-type',
    level: 2,
    fireplaceModeStatus: 0,
    fireplaceModeTime: 5,
  };
  const command = {
    ...raw,
    fireplaceModeStatus: 1,
    fireplaceModeTime: 45,
  };
  const configuration = {
    bridges: [{
      macAddress: 'fixture-bridge',
      appServerURL: 'https://appserver.example.invalid/',
      bridgeToken: 'fixture-bridge-token',
    }],
  };

  const write = client.writeParameter({
    userToken: 'fixture-user-token',
    configuration,
    raw,
    command,
    parameterName: 'fireplaceModeTime',
    value: 45,
    expectedFunctionName: 'dataWritten',
    expectedParameter: 'fireplaceModeTime',
    expectedValue: 45,
  });
  socket.emit('open');
  socket.emit('message', binaryMessage({ functionName: 'connectionStatus', status: 'OK' }));
  await Promise.resolve();

  assert.equal(socket.sent.length, 2);
  assert.ok(socket.sent.every(frame => frame instanceof Uint8Array));
  const [sync, writeData] = socket.sent.map(frame => JSON.parse(new TextDecoder().decode(frame)));
  assert.deepEqual(sync, {
    functionName: 'accountPropertiesChanged',
    itemName: 'deviceProperties',
    mustSyncOtherApps: true,
    payload: JSON.stringify([command]),
  });
  assert.deepEqual(writeData, {
    functionName: 'writeData',
    parameterName: 'fireplaceModeTime',
    data: 45,
    modbusAddress: 2,
    swVersion: 26,
    productType: 'fixture-product-type',
  });

  socket.emit('message', binaryMessage({
    functionName: 'dataWritten',
    parameterName: 'fireplaceModeTime',
    value: 45,
  }));
  await write;
  assert.equal(socket.closed, true);
});

test('send failures reject promptly with a redacted transport error and no unhandled rejection', async (t) => {
  const privateSendFailure = new Error('private-send-token');
  const privateCloseFailure = new Error('private-close-token');

  class ThrowingSocket extends FakeSocket {
    send() {
      throw privateSendFailure;
    }

    close() {
      throw privateCloseFailure;
    }
  }

  class RejectingSocket extends FakeSocket {
    send() {
      return Promise.reject(privateSendFailure);
    }

    close() {
      return Promise.reject(privateCloseFailure);
    }
  }

  class CallbackSocket extends FakeSocket {
    send(_data, callback) {
      queueMicrotask(() => callback?.(privateSendFailure));
    }
  }

  for (const [name, SocketType] of [
    ['synchronous throw', ThrowingSocket],
    ['rejected send promise', RejectingSocket],
    ['callback error', CallbackSocket],
  ]) {
    await t.test(name, async () => {
      const unhandled = [];
      const onUnhandled = reason => unhandled.push(reason);
      process.prependListener('unhandledRejection', onUnhandled);

      try {
        const sockets = [];
        const clock = new RecordingClock();
        const client = new VascoWebSocketClient({
          clock,
          createSocket: url => {
            const socket = new SocketType(url);
            sockets.push(socket);
            return socket;
          },
        });
        const write = writeFixture(client);

        sockets[0].emit('message', binaryMessage({
          functionName: 'connectionStatus',
          status: 'OK',
        }));
        await new Promise(resolve => setImmediate(resolve));
        sockets[1].emit('message', binaryMessage({
          functionName: 'connectionStatus',
          status: 'OK',
        }));
        const outcome = await Promise.race([
          write.then(
            () => ({ status: 'resolved' }),
            error => ({ error, status: 'rejected' }),
          ),
          new Promise(resolve => setImmediate(() => resolve({ status: 'pending' }))),
        ]);
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(outcome.status, 'rejected', 'send failure must not wait for timeout');
        assert.ok(outcome.error instanceof VascoTransportError);
        assert.equal(outcome.error.message, 'Vasco WebSocket command failed');
        assert.doesNotMatch(outcome.error.message, /private-(?:send|close)-token/);
        assert.equal(clock.cleared, 2);
        assert.deepEqual(unhandled, []);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });
  }
});

test('retries one transient WebSocket failure and resolves after the second acknowledgement', async () => {
  const sockets = [];
  const client = new VascoWebSocketClient({
    createSocket: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });

  const write = writeFixture(client);
  assert.equal(sockets.length, 1);
  sockets[0].emit('close');
  await Promise.resolve();

  assert.equal(sockets.length, 2);
  sockets[1].emit('message', binaryMessage({
    functionName: 'connectionStatus',
    status: 'OK',
  }));
  await Promise.resolve();
  sockets[1].emit('message', binaryMessage({
    functionName: 'dataWritten',
    parameterName: 'requestedLevel',
    value: 4,
  }));

  await write;
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets[1].closed, true);
});

test('stops after two transient WebSocket failures', async () => {
  const sockets = [];
  const client = new VascoWebSocketClient({
    createSocket: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });

  const write = writeFixture(client);
  sockets[0].emit('close');
  await Promise.resolve();
  sockets[1].emit('close');

  await assert.rejects(write, VascoTransportError);
  assert.equal(sockets.length, 2);
});

test('does not retry malformed WebSocket responses', async () => {
  const sockets = [];
  const client = new VascoWebSocketClient({
    createSocket: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });

  const write = writeFixture(client);
  sockets[0].emit('message', { data: '{not-json' });

  await assert.rejects(write, VascoProtocolError);
  assert.equal(sockets.length, 1);
});

test('uses a four-second timeout for each bounded WebSocket attempt', () => {
  const delays = [];
  const clock = {
    setTimeout: (_fn, delayMs) => {
      delays.push(delayMs);
      return Symbol('timeout');
    },
    clearTimeout: () => {},
  };
  const client = new VascoWebSocketClient({
    clock,
    createSocket: url => new FakeSocket(url),
  });

  void writeFixture(client).catch(() => {});

  assert.deepEqual(delays, [4_000]);
});

class RecordingClock {
  constructor() {
    this.cleared = 0;
  }

  setTimeout() {
    return Symbol('timeout');
  }

  clearTimeout() {
    this.cleared += 1;
  }
}

function writeFixture(client) {
  const raw = {
    macAddress: 'fixture-bridge',
    modbusAddress: 2,
    swVersion: 26,
    productType: 'fixture-product-type',
    level: 2,
  };
  return client.writeParameter({
    userToken: 'fixture-user-token',
    configuration: {
      bridges: [{
        macAddress: 'fixture-bridge',
        appServerURL: 'https://appserver.example.invalid/',
        bridgeToken: 'fixture-bridge-token',
      }],
    },
    raw,
    command: { ...raw, requestedLevel: 3 },
    parameterName: 'requestedLevel',
    value: 4,
    expectedFunctionName: 'dataWritten',
    expectedParameter: 'requestedLevel',
    expectedValue: 4,
  });
}
