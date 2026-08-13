const {
  VascoProtocolError,
  VascoTransportError,
} = require('./vasco-errors');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOCK = Object.freeze({
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: timer => clearTimeout(timer),
});

class VascoWebSocketClient {
  constructor({
    createSocket = url => new WebSocket(url),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    clock = DEFAULT_CLOCK,
  } = {}) {
    this.createSocket = createSocket;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
  }

  writeParameter({
    userToken,
    configuration,
    raw,
    command,
    parameterName,
    value,
    expectedFunctionName = 'valueChanged',
    expectedParameter,
    expectedValue,
  }) {
    const bridge = findBridge(configuration, raw);
    const url = createApplicationServerUrl(bridge, userToken);

    return new Promise((resolve, reject) => {
      const socket = this.createSocket(url);
      socket.binaryType = 'arraybuffer';
      let commandSent = false;
      let settled = false;
      const timeout = this.clock.setTimeout(
        () => finish(new VascoTransportError('Vasco WebSocket command timed out')),
        this.timeoutMs,
      );

      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timeout);
        socket.close();
        if (error) reject(error);
        else resolve();
      };

      socket.addEventListener('message', async event => {
        let message;
        try {
          message = JSON.parse(await decodeFrame(event.data));
        } catch {
          finish(new VascoProtocolError('Vasco WebSocket response is malformed'));
          return;
        }

        if (message.functionName === 'connectionStatus'
          && message.status === 'OK'
          && !commandSent) {
          commandSent = true;
          socket.send(encodeFrame({
            functionName: 'accountPropertiesChanged',
            itemName: 'deviceProperties',
            mustSyncOtherApps: true,
            payload: JSON.stringify([command]),
          }));
          socket.send(encodeFrame({
            functionName: 'writeData',
            parameterName,
            data: value,
            modbusAddress: raw.modbusAddress,
            swVersion: raw.swVersion,
            productType: raw.productType,
          }));
          return;
        }

        if (message.functionName === expectedFunctionName
          && message.parameterName === expectedParameter
          && message.value === expectedValue) {
          finish();
        }
      });
      socket.addEventListener('error', () => {
        finish(new VascoTransportError('Vasco WebSocket connection failed'));
      });
      socket.addEventListener('close', () => {
        if (!settled) finish(new VascoTransportError('Vasco WebSocket connection closed'));
      });
    });
  }
}

function findBridge(configuration, raw) {
  const bridges = Array.isArray(configuration?.bridges) ? configuration.bridges : [];
  const bridge = bridges.find(item => item?.macAddress === raw?.macAddress)
    ?? (bridges.length === 1 ? bridges[0] : null);
  if (!bridge?.appServerURL || !bridge?.bridgeToken) {
    throw new VascoProtocolError('Vasco application-server bridge is missing');
  }
  return bridge;
}

function createApplicationServerUrl(bridge, userToken) {
  let url;
  try {
    url = new URL(bridge.appServerURL);
  } catch {
    throw new VascoProtocolError('Vasco application-server URL is malformed');
  }
  url.protocol = 'wss:';
  url.search = new URLSearchParams({ bridgeToken: bridge.bridgeToken, userToken });
  return url.toString();
}

function encodeFrame(message) {
  return new TextEncoder().encode(JSON.stringify(message));
}

async function decodeFrame(frame) {
  if (typeof frame === 'string') return frame;
  if (frame instanceof ArrayBuffer || ArrayBuffer.isView(frame)) {
    return new TextDecoder().decode(frame);
  }
  if (typeof frame?.arrayBuffer === 'function') {
    return new TextDecoder().decode(await frame.arrayBuffer());
  }
  throw new TypeError('Unsupported WebSocket frame');
}

module.exports = { VascoWebSocketClient };
