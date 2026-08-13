# Fireplace Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate Fireplace Enable/Stop buttons with one stateful custom toggle backed by Vasco's reported Fireplace status.

**Architecture:** Make the existing `vasco_fireplace` boolean capability setable and register one listener that maps ON to the picker duration and OFF to zero. Keep Vasco as the state authority after acknowledgement. A version-5 migration removes both legacy button capabilities from already-paired devices without changing the tile indicator.

**Tech Stack:** Node.js 22, CommonJS, Homey Apps SDK v3, Homey Compose, `node:test`, official Homey CLI.

## Global Constraints

- Use the custom `vasco_fireplace` capability, not Homey's system `onoff`.
- ON sends the selected 5–85 minute picker duration; OFF sends exactly zero.
- The toggle value always reflects Vasco's `fireplaceModeStatus`; do not force OFF after an acknowledged zero write.
- Remove `button.enable_fireplace` and `button.stop_fireplace` from new and existing devices.
- Preserve the duration picker, mode-number tile indicator, and existing Enable Fireplace Flow action.
- Do not reintroduce local Fireplace sessions, countdowns, suppression, or prior-mode restoration.
- Do not expose credentials, Vasco tokens, raw identifiers, or capture artifacts.

---

### Task 1: Convert the device contract to a toggle

**Files:**
- Modify: `.homeycompose/capabilities/vasco_fireplace.json`
- Modify: `drivers/vasco-kermi-x/driver.compose.json`
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/homey-manifest.test.js`
- Modify: `test/unit/vasco-device.test.js`
- Regenerate: `app.json`

**Interfaces:**
- Produces: contract version `5`.
- Produces: getable/setable boolean `vasco_fireplace` rendered as a toggle.
- Migration removes `button.enable_fireplace` and `button.stop_fireplace` idempotently.

- [ ] **Step 1: Write failing manifest tests**

```js
test('Fireplace status is a setable custom toggle without legacy buttons', () => {
  const driver = readJson('drivers', 'vasco-kermi-x', 'driver.compose.json');
  const fireplace = readJson('.homeycompose', 'capabilities', 'vasco_fireplace.json');
  assert.equal(fireplace.getable, true);
  assert.equal(fireplace.setable, true);
  assert.equal(fireplace.uiComponent, 'toggle');
  assert.equal(driver.capabilities.includes('vasco_fireplace'), true);
  assert.equal(driver.capabilities.includes('button.enable_fireplace'), false);
  assert.equal(driver.capabilities.includes('button.stop_fireplace'), false);
});
```

- [ ] **Step 2: Write a failing version-5 migration test**

```js
test('device contract version five removes legacy Fireplace buttons', async () => {
  const { device } = createHarness({
    capabilities: ['vasco_fireplace', 'vasco_fireplace_duration',
      'button.enable_fireplace', 'button.stop_fireplace'],
    store: { device_contract_version: 4 },
  });
  await device.ensureDeviceContract();
  assert.equal(device.hasCapability('button.enable_fireplace'), false);
  assert.equal(device.hasCapability('button.stop_fireplace'), false);
  assert.equal(device.hasCapability('vasco_fireplace'), true);
  assert.equal(device.hasCapability('vasco_fireplace_duration'), true);
  assert.equal(device.getStoreValue('device_contract_version'), 5);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test --test-name-pattern='setable custom toggle|version five' test/unit/homey-manifest.test.js test/unit/vasco-device.test.js`

Expected: FAIL because the capability is a read-only sensor and contract v4 retains both buttons.

- [ ] **Step 4: Implement Compose and migration changes**

Change `.homeycompose/capabilities/vasco_fireplace.json` to:

```json
{
  "type": "boolean",
  "title": { "en": "Fireplace mode active", "pl": "Tryb kominka aktywny" },
  "titleTrue": { "en": "Fireplace mode enabled", "pl": "Tryb kominka włączony" },
  "titleFalse": { "en": "Fireplace mode disabled", "pl": "Tryb kominka wyłączony" },
  "getable": true,
  "setable": true,
  "uiComponent": "toggle"
}
```

Remove both button IDs and their `capabilitiesOptions` from the driver Compose file. Set `DEVICE_CONTRACT_VERSION = 5`, remove the buttons from `DEVICE_CONTRACT_CAPABILITIES`, and migrate versions below 5 with guarded `removeCapability` calls before persisting version 5.

- [ ] **Step 5: Regenerate and verify manifests**

Run: `npx homey app build`

Run: `node --test test/unit/homey-manifest.test.js test/unit/vasco-device.test.js`

Expected: all manifest and migration tests pass; generated `app.json` contains the toggle and neither legacy button.

- [ ] **Step 6: Commit Task 1**

```bash
git add .homeycompose/capabilities/vasco_fireplace.json drivers/vasco-kermi-x/driver.compose.json drivers/vasco-kermi-x/device.js test/unit/homey-manifest.test.js test/unit/vasco-device.test.js app.json
git commit -m "feat: replace Fireplace buttons with toggle"
```

### Task 2: Wire ON and OFF to direct Vasco commands

**Files:**
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/vasco-device.test.js`
- Test unchanged behavior: `test/unit/flow-cards.test.js`

**Interfaces:**
- Consumes: `writeFireplaceDuration(minutes) -> Promise<true>`.
- Produces: `setFireplaceState(enabled) -> Promise<true>` registered on `vasco_fireplace`.

- [ ] **Step 1: Write failing listener tests**

```js
test('Fireplace toggle ON sends the selected picker duration', async () => {
  const { device, service } = createHarness();
  device.capabilities.set('vasco_fireplace_duration', '45');
  await device.capabilityListeners.get('vasco_fireplace')(true);
  assert.equal(service.commands[0].command.fireplaceModeTime, 45);
});

test('Fireplace toggle OFF sends zero and retains Vasco active state', async () => {
  const { device, service } = createHarness();
  device.capabilities.set('vasco_fireplace', true);
  const execute = service.executeDeviceCommand.bind(service);
  service.executeDeviceCommand = async (identity, build, confirm) => {
    const state = await execute(identity, build, confirm);
    return { ...state, fireplaceModeStatus: 1 };
  };
  await device.capabilityListeners.get('vasco_fireplace')(false);
  assert.equal(service.commands[0].command.fireplaceModeTime, 0);
  assert.equal(device.getCapabilityValue('vasco_fireplace'), true);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern='Fireplace toggle ON|Fireplace toggle OFF' test/unit/vasco-device.test.js`

Expected: FAIL because no listener is registered for the toggle.

- [ ] **Step 3: Implement the toggle listener**

Replace both button listeners with:

```js
this.registerCapabilityListener('vasco_fireplace', enabled => (
  this.setFireplaceState(enabled)
));
```

Implement:

```js
async setFireplaceState(enabled) {
  if (enabled === true) {
    return this.writeFireplaceDuration(defaultFireplaceMinutes(
      this.getCapabilityValue('vasco_fireplace_duration'),
    ));
  }
  if (enabled === false) return this.writeFireplaceDuration(0);
  throw new TypeError('Fireplace state must be boolean');
}
```

Do not call `setCapabilityValue` optimistically. `writeFireplaceDuration` applies only the state returned by the account service, and polling remains authoritative.

- [ ] **Step 4: Remove obsolete button method wrappers and tests**

Remove `stopFireplace()` and any button-listener assertions. Keep `setFireplace(minutes)` because the existing Flow action consumes it. Verify no runtime references remain:

Run: `rg -n "button\.enable_fireplace|button\.stop_fireplace|stopFireplace" drivers app.js test/unit`

Expected: no production references; migration-test literals are allowed.

- [ ] **Step 5: Run focused and retained suites**

Run: `node --test test/unit/vasco-device.test.js test/unit/flow-cards.test.js`

Expected: toggle tests pass and the existing Enable Flow action still sends its explicit 1–1440 minute duration.

- [ ] **Step 6: Commit Task 2**

```bash
git add drivers/vasco-kermi-x/device.js test/unit/vasco-device.test.js
git commit -m "feat: control Fireplace mode with toggle"
```

### Task 3: Verify, install, and physically confirm

**Files:**
- Modify only if verification exposes a defect in files already listed above.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: validated installation and observed X500 behavior.

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`

Expected: exit zero, no failed/cancelled/timed-out tests.

- [ ] **Step 2: Run security fallback and Homey validation**

Run Aikido on modified code when available. If unavailable, report it and run:

```bash
node --test test/secret-safety.test.js
git diff --check
npx homey app validate --level=debug
npx homey app validate --level=publish
```

Expected: every command exits zero.

- [ ] **Step 3: Confirm target and install persistently**

Run: `homey select current`

Expected: `Homey Pro (66ed660f9d397dcbcfe1ac46)`.

Run: `npx homey app install`

Expected: app installs successfully without re-pairing the device.

- [ ] **Step 4: Verify migrated capabilities read-only**

Fetch device `2dc8f187-d214-4d5b-8dc4-d3aa005375fc` and confirm:

- `vasco_fireplace` is present and setable;
- `vasco_fireplace_duration` is present;
- both button capabilities are absent;
- `uiIndicator` remains `measure_vasco_mode`;
- device is available and ready.

- [ ] **Step 5: Physical smoke test**

With the picker set to 5 minutes, ask the user to switch Fireplace ON and confirm Vasco activates it. Then switch OFF once. The accepted firmware-v26 result is: no Homey error, Vasco remains active, and the Homey toggle remains/returns ON because raw `fireplaceModeStatus` is still active.
