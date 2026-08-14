# Direct Fireplace Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Homey's local Fireplace-session emulation with direct Vasco-compatible duration writes, including zero minutes for Stop.

**Architecture:** Treat `fireplaceModeTime` as a direct WebSocket command acknowledged by `dataWritten`. The device retains no Fireplace timer or prior-mode state; normal Vasco polling is the sole source of `fireplaceModeStatus`. A version-4 device-contract migration removes the obsolete remaining-time capability and stored session.

**Tech Stack:** Node.js 22, CommonJS, Homey Apps SDK v3, Homey Compose, `node:test`, official Homey CLI.

## Global Constraints

- Enable uses the selected duration; Stop writes exactly `fireplaceModeTime: 0`.
- A positive `dataWritten` acknowledgement completes the command without claiming that firmware applied it.
- `fireplaceModeStatus` from Vasco is the only displayed Fireplace state.
- Preserve the 5–85 minute picker, Enable button, Stop button, and existing Enable Flow action.
- Remove `measure_fireplace_remaining`, local countdowns, prior-mode restoration, suppression, and persisted Fireplace sessions.
- Do not expose credentials, Vasco tokens, raw device identifiers, or capture artifacts in logs, tests, commits, or errors.

---

### Task 1: Model direct Fireplace duration commands

**Files:**
- Modify: `lib/vasco-command-builder.js`
- Modify: `lib/vasco-account-service.js`
- Test: `test/unit/vasco-command-builder.test.js`
- Test: `test/unit/vasco-account-service.test.js`

**Interfaces:**
- Produces: `buildFireplaceCommand(raw, { minutes }) -> cloned command`, where `minutes` is an integer from 0 through 1440.
- Produces: `isFireplaceCommand(command) -> boolean` for zero and positive duration commands.
- Consumes: `apiClient.writeDeviceParameter({ parameterName: "fireplaceModeTime", value, expectedFunctionName: "dataWritten", expectedParameter: "fireplaceModeTime", expectedValue: value })`.

- [ ] **Step 1: Replace the builder tests with failing direct-command cases**

```js
test('buildFireplaceCommand encodes enable and stop without mutating raw state', () => {
  for (const minutes of [0, 45]) {
    const command = buildFireplaceCommand(rawDevice, { minutes });
    assert.equal(command.fireplaceModeTime, minutes);
    assert.equal(command.fireplaceModeStatus, rawDevice.fireplaceModeStatus);
  }
});

test('isFireplaceCommand accepts zero and positive whole-minute writes', () => {
  assert.equal(isFireplaceCommand(buildFireplaceCommand(rawDevice, { minutes: 0 })), true);
  assert.equal(isFireplaceCommand(buildFireplaceCommand(rawDevice, { minutes: 45 })), true);
});
```

- [ ] **Step 2: Run builder tests and verify RED**

Run: `node --test test/unit/vasco-command-builder.test.js`

Expected: FAIL because `buildFireplaceCommand` and `isFireplaceCommand` are not exported.

- [ ] **Step 3: Implement the generic command builder**

```js
function buildFireplaceCommand(raw, { minutes }) {
  const command = cloneRaw(raw);
  command.fireplaceModeTime = validatedFireplaceMinutes(minutes);
  return command;
}

function validatedFireplaceMinutes(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw new RangeError('Vasco Fireplace duration must be a whole number from 0 to 1440 minutes');
  }
  return minutes;
}
```

Remove `buildFireplaceEnableCommand` and `isFireplaceEnableCommand`; update imports and exports.

- [ ] **Step 4: Add a failing account-service test for zero**

```js
test('Fireplace Stop writes zero and completes on WebSocket acknowledgement', async () => {
  const writes = [];
  const service = createService({
    login: async () => OLD_TOKEN,
    getAccountConfiguration: async () => fixture,
    setDeviceProperties: async () => ({}),
    writeDeviceParameter: async options => writes.push(options),
  });
  const state = await service.executeDeviceCommand(
    KITCHEN.identity,
    raw => buildFireplaceCommand(raw, { minutes: 0 }),
  );
  assert.equal(writes[0].parameterName, 'fireplaceModeTime');
  assert.equal(writes[0].value, 0);
  assert.equal(state.fireplaceModeStatus, fixture.deviceProperties[0].fireplaceModeStatus);
});
```

- [ ] **Step 5: Run the account-service test and verify RED**

Run: `node --test --test-name-pattern='Fireplace Stop' test/unit/vasco-account-service.test.js`

Expected: FAIL because the service recognizes only positive enable commands and requires a state-confirmation callback.

- [ ] **Step 6: Make Fireplace acknowledgement a first-class command result**

Change `executeDeviceCommand(identity, build, confirm = null)` so a recognized Fireplace command:

```js
await this.apiClient.writeDeviceParameter({
  userToken: session.token,
  configuration: before,
  raw: device.raw,
  command,
  parameterName: 'fireplaceModeTime',
  value: command.fireplaceModeTime,
  expectedFunctionName: 'dataWritten',
  expectedParameter: 'fireplaceModeTime',
  expectedValue: command.fireplaceModeTime,
});
acknowledgedState = toDeviceState(device.raw);
```

Return that state immediately for Fireplace commands after acknowledgement. Keep existing REST write and mode-command confirmation semantics unchanged.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `node --test test/unit/vasco-command-builder.test.js test/unit/vasco-account-service.test.js`

Expected: all tests pass with zero confirmation polling after a positive Fireplace acknowledgement.

- [ ] **Step 8: Commit Task 1**

```bash
git add lib/vasco-command-builder.js lib/vasco-account-service.js test/unit/vasco-command-builder.test.js test/unit/vasco-account-service.test.js
git commit -m "feat: send direct Vasco Fireplace commands"
```

### Task 2: Remove local Fireplace session emulation

**Files:**
- Modify: `drivers/vasco-kermi-x/device.js`
- Delete: `lib/vasco-fireplace-session.js`
- Delete: `test/unit/vasco-fireplace-session.test.js`
- Modify: `test/unit/vasco-device.test.js`

**Interfaces:**
- Consumes: `buildFireplaceCommand(raw, { minutes })` from Task 1.
- Produces: `setFireplace(minutes) -> Promise<true>` and `stopFireplace() -> Promise<true>` with no local session state.

- [ ] **Step 1: Replace session-based device tests with failing direct-control tests**

```js
test('Fireplace Enable sends the selected duration without local session state', async () => {
  const { device, service } = createHarness();
  await device.setFireplace(45);
  assert.equal(service.commands[0].command.fireplaceModeTime, 45);
  assert.equal(device.getStoreValue('fireplace_session'), null);
});

test('Fireplace Stop sends zero and leaves status reconciliation to Vasco', async () => {
  const { device, service } = createHarness();
  await device.stopFireplace();
  assert.equal(service.commands[0].command.fireplaceModeTime, 0);
  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
});
```

Also change listener assertions so Enable calls `setFireplace(selectedMinutes)` and Stop calls `stopFireplace()` regardless of where the active mode was started.

- [ ] **Step 2: Run the focused device tests and verify RED**

Run: `node --test --test-name-pattern='Fireplace Enable sends|Fireplace Stop sends' test/unit/vasco-device.test.js`

Expected: FAIL because current Enable creates a stored session and Stop restores a prior mode.

- [ ] **Step 3: Simplify device initialization and listeners**

Remove `FIREPLACE_SESSION_STORE_KEY`, `MINUTE_MS`, the session imports, `fireplaceSession`, `fireplaceTimer`, session restoration, timer cleanup, countdown handling, suppression reconciliation, rollback machinery, and their lifecycle calls.

Register controls as:

```js
this.registerCapabilityListener('button.enable_fireplace', () => (
  this.setFireplace(defaultFireplaceMinutes(
    this.getCapabilityValue('vasco_fireplace_duration'),
  ))
));
this.registerCapabilityListener('button.stop_fireplace', () => this.stopFireplace());
```

- [ ] **Step 4: Implement direct device methods**

```js
async setFireplace(minutes) {
  return this.writeFireplaceDuration(validatedMinutes(minutes, 'Fireplace duration'));
}

async stopFireplace() {
  return this.writeFireplaceDuration(0);
}

async writeFireplaceDuration(minutes) {
  try {
    const state = await this.accountService.executeDeviceCommand(
      this.identity,
      raw => buildFireplaceCommand(raw, { minutes }),
    );
    await this.applyState(state, { initial: false });
    return true;
  } catch (error) {
    this.error('Vasco Fireplace command failed', diagnosticError(error));
    throw new Error('Vasco did not acknowledge the Fireplace command.');
  }
}
```

Reduce `reconcileFireplaceStateNow` to direct mapping or remove it and let the existing `vasco_fireplace` mapper use `flagValue(state.fireplaceModeStatus)`.

- [ ] **Step 5: Delete session-only production and test modules**

Delete `lib/vasco-fireplace-session.js` and `test/unit/vasco-fireplace-session.test.js`; remove every import and reference verified by:

Run: `rg -n "fireplaceSession|fireplaceTimer|fireplace_session|measure_fireplace_remaining|vasco-fireplace-session" drivers lib test`

Expected: only manifest assertions and migration-specific cleanup references remain until Task 3.

- [ ] **Step 6: Run device and app tests and verify GREEN**

Run: `node --test test/unit/vasco-device.test.js test/unit/app.test.js`

Expected: all retained direct-control, status-transition, polling, and lifecycle tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add drivers/vasco-kermi-x/device.js lib/vasco-fireplace-session.js test/unit/vasco-fireplace-session.test.js test/unit/vasco-device.test.js
git commit -m "refactor: remove local Fireplace sessions"
```

### Task 3: Migrate the Homey device contract and UI

**Files:**
- Modify: `drivers/vasco-kermi-x/driver.compose.json`
- Delete: `.homeycompose/capabilities/measure_fireplace_remaining.json`
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/homey-manifest.test.js`
- Modify: `test/unit/vasco-device.test.js`
- Regenerate: `app.json`

**Interfaces:**
- Produces: device contract version `4`.
- Migration removes capability `measure_fireplace_remaining` and store key `fireplace_session` idempotently.

- [ ] **Step 1: Write failing manifest and migration tests**

```js
test('Fireplace controls omit the unsupported remaining-time capability', () => {
  const driver = readJson('drivers', 'vasco-kermi-x', 'driver.compose.json');
  assert.equal(driver.capabilities.includes('measure_fireplace_remaining'), false);
});

test('device contract version four removes legacy Fireplace session state', async () => {
  const { device } = createHarness({
    capabilities: ['measure_fireplace_remaining'],
    store: { device_contract_version: 3, fireplace_session: { version: 1 } },
  });
  await device.ensureDeviceContract();
  assert.equal(device.hasCapability('measure_fireplace_remaining'), false);
  assert.equal(device.getStoreValue('fireplace_session'), null);
  assert.equal(device.getStoreValue('device_contract_version'), 4);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test --test-name-pattern='remaining-time|version four' test/unit/homey-manifest.test.js test/unit/vasco-device.test.js`

Expected: FAIL because version 3 retains the capability and store value.

- [ ] **Step 3: Implement the version-4 migration**

Set `DEVICE_CONTRACT_VERSION = 4`, remove the capability from `DEVICE_CONTRACT_CAPABILITIES`, and add before saving the version:

```js
if (version < 4) {
  if (this.hasCapability('measure_fireplace_remaining')) {
    await this.removeCapability('measure_fireplace_remaining');
  }
  if (this.getStoreValue('fireplace_session') !== null
    && this.getStoreValue('fireplace_session') !== undefined) {
    await this.unsetStoreValue('fireplace_session');
  }
}
```

Remove `measure_fireplace_remaining` from the driver capabilities and delete its Compose definition.

- [ ] **Step 4: Regenerate and test manifests**

Run: `npx homey app build`

Run: `node --test test/unit/homey-manifest.test.js test/unit/vasco-device.test.js`

Expected: generated `app.json` contains the picker and both buttons but no remaining-time capability; migration tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add .homeycompose/capabilities/measure_fireplace_remaining.json drivers/vasco-kermi-x/driver.compose.json drivers/vasco-kermi-x/device.js test/unit/homey-manifest.test.js test/unit/vasco-device.test.js app.json
git commit -m "feat: simplify Fireplace device controls"
```

### Task 4: Verify, install, and physically test

**Files:**
- Modify only if verification finds a defect in files already listed above.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: validated and physically observed behavior on Homey Pro.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: process exits zero with no failed, cancelled, or timed-out tests.

- [ ] **Step 2: Run security checks**

Run the Aikido full scan on every modified code file. If Aikido MCP is unavailable, report that explicitly and run:

```bash
node --test test/secret-safety.test.js
git diff --check
```

Expected: no findings, leaked secrets, capture artifacts, or whitespace errors.

- [ ] **Step 3: Validate both Homey levels**

Run: `npx homey app validate --level=debug`

Run: `npx homey app validate --level=publish`

Expected: both validations succeed.

- [ ] **Step 4: Confirm the active Homey and install**

Run: `homey select current`

Expected: `Homey Pro (66ed660f9d397dcbcfe1ac46)`.

Run: `npx homey app install`

Expected: `com.shejnowicz.vasco-kermi-x` installs successfully.

- [ ] **Step 5: Verify migrated device metadata read-only**

Fetch device `2dc8f187-d214-4d5b-8dc4-d3aa005375fc` with `homey api devices get-device` and verify:

- `measure_fireplace_remaining` is absent;
- `vasco_fireplace_duration`, `button.enable_fireplace`, and `button.stop_fireplace` are present;
- the device is available and ready.

- [ ] **Step 6: Perform the necessary physical test with the user**

Ask the user to enable Fireplace for 5 minutes, confirm the Vasco app and physical unit enter Fireplace mode, then press Stop once. Confirm the Homey action completes after the WebSocket acknowledgement and record the actual Vasco status without overriding it: firmware v26 may remain active.
