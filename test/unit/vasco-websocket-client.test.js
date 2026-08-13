const test = require('node:test');
const assert = require('node:assert/strict');

const { VascoWebSocketClient } = require('../../lib/vasco-websocket-client');

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
