# Homey Device Controls and Tile Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make until-schedule the explained default, replace the misleading Fireplace toggle with status plus an enable button, and expose the current operating-mode number as a Homey tile indicator.

**Architecture:** Homey Compose defines the settings and capabilities. `device.js` owns an idempotent initialization migration, registers the explicit Fireplace button, and maps each Vasco state to both the enum picker and numeric indicator through its existing serialized state queue. A device-store migration marker changes the pre-release default once without overwriting later user choices.

**Tech Stack:** Homey Apps SDK v3, Homey Compose, Node.js 22 CommonJS, built-in `node:test` and `assert`.

## Global Constraints

- Keep `vasco_fireplace` as a read-only state; do not implement Fireplace disable.
- `button.enable_fireplace` uses `default_fireplace_minutes`.
- Mode indicator values remain the Vasco levels `1`, `2`, `3`, `4`, `6`, and `7` with no unit.
- Homey controls tile-indicator selection; the app only exposes an eligible numeric measurement.
- Existing pre-release devices migrate to `schedule` exactly once and later user choices are preserved.
- Modify Homey Compose sources, never generated `app.json` directly.

---

### Task 1: Compose settings and capabilities

**Files:**
- Modify: `drivers/vasco-kermi-x/driver.settings.compose.json`
- Modify: `drivers/vasco-kermi-x/driver.compose.json`
- Modify: `.homeycompose/capabilities/vasco_fireplace.json`
- Create: `.homeycompose/capabilities/measure_vasco_mode.json`
- Modify: `test/unit/homey-manifest.test.js`

**Interfaces:**
- Produces: read-only `vasco_fireplace`, system button `button.enable_fireplace`, numeric `measure_vasco_mode`, and `default_duration_type` hint text.

- [ ] **Step 1: Write failing manifest tests**

Assert that the setting defaults to `schedule` and contains bilingual hints mentioning the device picker and Flow overrides. Assert that `vasco_fireplace.setable === false`, `vasco_fireplace.uiComponent === "sensor"`, the driver includes `button.enable_fireplace` and `measure_vasco_mode`, and the numeric capability is getable, non-setable, integer, unitless, and bilingual.

```js
assert.equal(duration.value, 'schedule');
assert.match(duration.hint.en, /device.*Flow/i);
assert.match(duration.hint.pl, /urządzeni.*Flow/i);
assert.equal(fireplace.setable, false);
assert.equal(fireplace.uiComponent, 'sensor');
assert.ok(driver.capabilities.includes('button.enable_fireplace'));
assert.ok(driver.capabilities.includes('measure_vasco_mode'));
assert.equal(modeNumber.type, 'number');
assert.equal(modeNumber.decimals, 0);
assert.equal(modeNumber.setable, false);
assert.equal(Object.hasOwn(modeNumber, 'units'), false);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/unit/homey-manifest.test.js`

Expected: FAIL because the button and numeric capability do not exist and Fireplace remains setable.

- [ ] **Step 3: Implement the Compose contract**

Add the bilingual setting hint. Change `vasco_fireplace` to a read-only sensor titled `Fireplace mode active` / `Tryb kominka aktywny`. Add `button.enable_fireplace` to the driver with bilingual title and description. Define `measure_vasco_mode` as a getable, non-setable number with `min: 1`, `max: 7`, `step: 1`, `decimals: 0`, no `units`, and bilingual title.

- [ ] **Step 4: Verify GREEN and validate Compose**

Run:

```bash
node --test test/unit/homey-manifest.test.js
npx homey app validate --level=debug
```

Expected: PASS and Homey debug validation succeeds.

- [ ] **Step 5: Commit**

```bash
git add .homeycompose/capabilities/vasco_fireplace.json .homeycompose/capabilities/measure_vasco_mode.json drivers/vasco-kermi-x/driver.compose.json drivers/vasco-kermi-x/driver.settings.compose.json test/unit/homey-manifest.test.js
git commit -m "feat: define explicit Fireplace controls and mode indicator"
```

### Task 2: Idempotent existing-device migration

**Files:**
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/vasco-device.test.js`

**Interfaces:**
- Produces: `ensureDeviceContract()` called before capability listeners and account acquisition.
- Uses store key: `device_contract_version`, current version `1`.

- [ ] **Step 1: Extend the Homey device double and write failing migration tests**

Add `hasCapability`, `addCapability`, `removeCapability`, `getStoreValue`, and `setStoreValue` to `HomeyDeviceDouble`. Record capability mutations and store writes. Test that a version-zero device:

```js
await device.ensureDeviceContract();
assert.deepEqual(device.capabilityAdds, ['button.enable_fireplace', 'measure_vasco_mode']);
assert.deepEqual(device.settingsWrites, [{ default_duration_type: 'schedule' }]);
assert.equal(device.store.device_contract_version, 1);
```

Also test that version `1` preserves an explicit `permanent` setting and performs no capability or settings writes.

- [ ] **Step 2: Run the focused migration tests and verify RED**

Run: `node --test --test-name-pattern='device contract|duration migration' test/unit/vasco-device.test.js`

Expected: FAIL because `ensureDeviceContract` is missing.

- [ ] **Step 3: Implement `ensureDeviceContract()`**

Before acquiring the account in `onInit`, ensure `button.enable_fireplace` and `measure_vasco_mode` exist. On migration versions below `1`, set `default_duration_type: 'schedule'` only when the stored value is the pre-release `permanent`, then write `device_contract_version: 1`. Let failures reject initialization so the contract is never silently partial.

- [ ] **Step 4: Verify migration behavior**

Run: `node --test --test-name-pattern='device contract|duration migration' test/unit/vasco-device.test.js`

Expected: PASS for first migration, repeat initialization, and preservation tests.

- [ ] **Step 5: Commit**

```bash
git add drivers/vasco-kermi-x/device.js test/unit/vasco-device.test.js
git commit -m "feat: migrate existing Vasco device controls"
```

### Task 3: Fireplace button behavior

**Files:**
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/vasco-device.test.js`

**Interfaces:**
- Consumes: `button.enable_fireplace` from Task 1.
- Produces: capability listener calling `setFireplace(true, defaultFireplaceMinutes(settings))`.

- [ ] **Step 1: Write failing listener tests**

Update initialization expectations so no listener exists for `vasco_fireplace`. Assert a listener exists for `button.enable_fireplace`, invoke it, and verify the command contains the configured duration:

```js
assert.equal(device.capabilityListeners.has('vasco_fireplace'), false);
const press = device.capabilityListeners.get('button.enable_fireplace');
await press();
assert.equal(service.commands.at(-1).command.fireplaceModeStatus, 1);
assert.equal(service.commands.at(-1).command.fireplaceModeTime, 17);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern='Fireplace button|initialization acquires' test/unit/vasco-device.test.js`

Expected: FAIL because the old writable toggle listener is still registered.

- [ ] **Step 3: Replace the listener**

Remove registration of `vasco_fireplace`. Register `button.enable_fireplace` with a zero-argument listener that always calls `setFireplace(true, defaultFireplaceMinutes(this.getSettings()))`. Keep `setFireplace(false, ...)` blocked defensively for internal callers.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='Fireplace button|initialization acquires' test/unit/vasco-device.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add drivers/vasco-kermi-x/device.js test/unit/vasco-device.test.js
git commit -m "feat: replace Fireplace toggle with enable button"
```

### Task 4: Numeric operating-mode synchronization

**Files:**
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/vasco-device.test.js`

**Interfaces:**
- Consumes: mapped `state.requestedMode` with fallback to `state.mode`.
- Produces: `measure_vasco_mode` capability value `1|2|3|4|6|7`.

- [ ] **Step 1: Write failing state-application tests**

For each supported level, apply a mapped state and assert both capabilities:

```js
for (const [level, mode] of [[1, 'low'], [2, 'medium'], [3, 'high'], [4, 'auto'], [6, 'holidays'], [7, 'guests']]) {
  await device.applyState({ ...baseState, mode: level, requestedMode: level }, { initial: true });
  assert.equal(device.getCapabilityValue('vasco_mode'), mode);
  assert.equal(device.getCapabilityValue('measure_vasco_mode'), level);
}
```

Add a test that optimistic command acknowledgement immediately updates both values before a later poll.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern='mode number|optimistic' test/unit/vasco-device.test.js`

Expected: FAIL because `measure_vasco_mode` is not mapped.

- [ ] **Step 3: Add the capability mapping**

Add `['measure_vasco_mode', state => MODE_BY_LEVEL.has(state.requestedMode) ? state.requestedMode : null]` immediately after `vasco_mode` in `CAPABILITIES`. This keeps enum and number writes in one serialized state operation.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='mode number|optimistic' test/unit/vasco-device.test.js`

Expected: PASS for all six modes.

- [ ] **Step 5: Commit**

```bash
git add drivers/vasco-kermi-x/device.js test/unit/vasco-device.test.js
git commit -m "feat: expose numeric Vasco mode indicator"
```

### Task 5: Release verification and physical installation

**Files:**
- Modify only if generated by Compose: `app.json`

**Interfaces:**
- Verifies the complete device contract on the user's X500.

- [ ] **Step 1: Run all automated checks**

Run:

```bash
npm test
npx homey app validate --level=debug
git diff --check
```

Expected: all tests pass, validation succeeds, and `git diff --check` prints nothing.

- [ ] **Step 2: Run the required security scan**

Use the configured Aikido scan on modified code files. Expected: no newly introduced SAST issue or exposed secret. If Aikido is unavailable, report that explicitly and run the repository's available secret/private-artifact tests as fallback.

- [ ] **Step 3: Install on Homey**

Run: `npx homey app install`

Expected: installation succeeds and the existing paired device remains present.

- [ ] **Step 4: Verify UI and behavior physically**

Confirm:

1. `Default control duration` is `Until next schedule change` and displays its explanatory hint.
2. Fireplace appears as read-only status plus `Enable Fireplace mode` button, with no On/Off switch.
3. Pressing the Fireplace button is not required for migration verification and must not be done accidentally.
4. `Operating mode number` is available in the tile indicator selector; select it if Homey did not do so automatically.
5. Changing Low → Medium → High updates the tile indicator to `1 → 2 → 3`.
6. Auto, Holidays, and Guests show `4`, `6`, and `7` without a command error.

- [ ] **Step 5: Commit generated manifest if changed**

```bash
git add app.json
git commit -m "build: refresh Homey Compose manifest"
```

Skip this commit when `app.json` is unchanged.
