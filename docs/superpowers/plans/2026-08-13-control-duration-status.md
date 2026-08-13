# Control Duration Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Vasco control duration on the Homey device and expose it through an And Flow condition.

**Architecture:** A pure mapper converts the validated Vasco control fields into one of three stable Homey enum IDs. The existing serialized device state application writes the derived capability, while an app-level device condition compares the requested value locally. A version-3 device-contract migration adds the new capability without modifying existing controls.

**Tech Stack:** Node.js 22, CommonJS, Homey Apps SDK v3, Homey Compose, `node:test`, Homey CLI.

## Global Constraints

- Keep `vasco_control_state` and `manual_override_is_active` unchanged.
- Add no network calls, writable commands, or Flow triggers.
- Use the stable values `until_schedule`, `permanent`, and `timed` everywhere.
- Unknown, contradictory, malformed, or expired upstream state maps to `null` and does not overwrite the last valid capability value.
- Edit Homey Compose sources only; never edit generated `app.json` directly.
- Use `this.homey.*` timers if a timer becomes necessary; this design requires no new timer.

---

### Task 1: Pure control-duration mapper

**Files:**
- Create: `lib/vasco-control-duration.js`
- Create: `test/unit/vasco-control-duration.test.js`

**Interfaces:**
- Produces: `controlDurationValue(state: object, nowMs: number): "until_schedule" | "permanent" | "timed" | null`.
- Consumes: Vasco state fields `controlMode` and `manualSettingActiveTill`.

- [ ] **Step 1: Write the failing mapper tests**

Cover the exact accepted states and reject boundary ambiguity:

```js
test('maps schedule, permanent, and future timed Vasco control states', () => {
  assert.equal(controlDurationValue({
    controlMode: 'schedule', manualSettingActiveTill: 0,
  }, NOW_MS), 'until_schedule');
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: -1,
  }, NOW_MS), 'permanent');
  assert.equal(controlDurationValue({
    controlMode: 'manual', manualSettingActiveTill: NOW_MS + 1,
  }, NOW_MS), 'timed');
});

test('returns null for unknown, contradictory, and expired control states', () => {
  for (const state of [
    {},
    { controlMode: 'other', manualSettingActiveTill: 0 },
    { controlMode: 'manual', manualSettingActiveTill: 0 },
    { controlMode: 'schedule', manualSettingActiveTill: -1 },
    { controlMode: 'schedule', manualSettingActiveTill: NOW_MS + 1 },
    { controlMode: 'manual', manualSettingActiveTill: NOW_MS },
  ]) assert.equal(controlDurationValue(state, NOW_MS), null);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/unit/vasco-control-duration.test.js`

Expected: FAIL because `lib/vasco-control-duration.js` does not exist.

- [ ] **Step 3: Implement the minimal pure mapper**

```js
'use strict';

function controlDurationValue(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object' || !Number.isSafeInteger(nowMs)) return null;
  const { controlMode, manualSettingActiveTill } = state;
  if (!Number.isSafeInteger(manualSettingActiveTill)) return null;
  if (controlMode === 'schedule' && manualSettingActiveTill === 0) {
    return 'until_schedule';
  }
  if (controlMode === 'manual' && manualSettingActiveTill === -1) {
    return 'permanent';
  }
  if (controlMode === 'manual' && manualSettingActiveTill > nowMs) {
    return 'timed';
  }
  return null;
}

module.exports = { controlDurationValue };
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test test/unit/vasco-control-duration.test.js`

Expected: all mapper tests pass.

```bash
git add lib/vasco-control-duration.js test/unit/vasco-control-duration.test.js
git commit -m "feat: map Vasco control duration"
```

---

### Task 2: Device capability and version-3 migration

**Files:**
- Create: `.homeycompose/capabilities/vasco_control_duration.json`
- Modify: `drivers/vasco-kermi-x/driver.compose.json`
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/homey-manifest.test.js`
- Modify: `test/unit/vasco-device.test.js`

**Interfaces:**
- Consumes: `controlDurationValue(state, nowMs)` from Task 1.
- Produces: read-only enum capability `vasco_control_duration` and device contract version `3`.

- [ ] **Step 1: Write failing Compose contract tests**

Assert that the capability is a getable, non-setable sensor with exactly these bilingual values:

```js
assert.deepEqual(controlDuration.values.map(value => value.id), [
  'until_schedule', 'permanent', 'timed',
]);
assert.equal(controlDuration.getable, true);
assert.equal(controlDuration.setable, false);
assert.equal(controlDuration.uiComponent, 'sensor');
assert.ok(driver.capabilities.includes('vasco_control_duration'));
```

Also assert it is placed immediately after `vasco_control_state` on the device screen.

- [ ] **Step 2: Write failing migration and synchronization tests**

Add tests proving:

```js
device.store.device_contract_version = 2;
await device.ensureDeviceContract();
assert.deepEqual(device.capabilityAdds, ['vasco_control_duration']);
assert.equal(device.store.device_contract_version, 3);
```

For version 3, assert no capability is added and no existing value is overwritten. Extend state-application scenarios to verify schedule, permanent, and timed values. Apply a malformed state after a valid state and assert the valid capability remains unchanged.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='control duration|device contract|initialization acquires|applyState' test/unit/homey-manifest.test.js test/unit/vasco-device.test.js
```

Expected: FAIL because the capability, migration, and mapping do not exist.

- [ ] **Step 4: Add the Compose capability and driver ordering**

Create an enum capability titled `Control duration` / `Sposób sterowania`, with these value titles:

```json
[
  { "id": "until_schedule", "title": { "en": "Until next schedule change", "pl": "Do następnej zmiany harmonogramu" } },
  { "id": "permanent", "title": { "en": "Permanent", "pl": "Na stałe" } },
  { "id": "timed", "title": { "en": "Timed", "pl": "Czasowo" } }
]
```

Insert `vasco_control_duration` directly after `vasco_control_state` in the driver capability list.

- [ ] **Step 5: Implement migration and state synchronization**

In `device.js`:

- import `controlDurationValue`;
- set `DEVICE_CONTRACT_VERSION = 3`;
- append `vasco_control_duration` to `DEVICE_CONTRACT_CAPABILITIES`;
- add `['vasco_control_duration', (state, device) => controlDurationValue(state, device.getNow())]` to `CAPABILITIES`;
- change the capability-loop invocation from `mapValue(state)` to `mapValue(state, this)` so only the new mapper consumes the device clock while existing mappers safely ignore the extra argument;
- preserve the existing rule in `applyStateNow` that skips `null` and `undefined` values.

Keep all version-1 and version-2 migration behavior intact.

- [ ] **Step 6: Verify GREEN and commit**

Run the focused command from Step 3, then run `npm test`.

Expected: focused tests and the full suite pass.

```bash
git add .homeycompose/capabilities/vasco_control_duration.json drivers/vasco-kermi-x/driver.compose.json drivers/vasco-kermi-x/device.js test/unit/homey-manifest.test.js test/unit/vasco-device.test.js
git commit -m "feat: expose control duration on Vasco devices"
```

---

### Task 3: And Flow condition

**Files:**
- Create: `.homeycompose/flow/conditions/control_duration_is.json`
- Modify: `app.js`
- Modify: `test/unit/flow-cards.test.js`

**Interfaces:**
- Consumes: device capability `vasco_control_duration`.
- Produces: device condition card `control_duration_is` with dropdown argument `duration`.

- [ ] **Step 1: Write failing Flow manifest tests**

Add the expected bilingual card title:

```js
control_duration_is: labels(
  'Control duration',
  'Sposób sterowania',
  'Control duration !{{is|isn\'t}} [[duration]]',
  'Sposób sterowania !{{to|nie jest}} [[duration]]',
),
```

Assert the `duration` dropdown contains, in order, `until_schedule`, `permanent`, and `timed`, with the same titles as the capability.

- [ ] **Step 2: Write failing listener behavior tests**

Extend the device double with `vasco_control_duration: 'until_schedule'`, expose its existing `values` map from `createDevice()`, then assert:

```js
const run = conditions.get('control_duration_is').listeners[0];
assert.equal(await run({ device, duration: 'until_schedule' }), true);
assert.equal(await run({ device, duration: 'permanent' }), false);
```

Set the double's capability to `null` and assert all three comparisons return false. Homey owns condition inversion; the listener returns only the direct comparison.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test test/unit/flow-cards.test.js`

Expected: FAIL because the Compose card and run listener do not exist.

- [ ] **Step 4: Add the card and listener**

Create a device condition with `driver_id=vasco-kermi-x` and the exact dropdown values. Register:

```js
condition('control_duration_is', ({ device, duration }) => {
  const value = requiredDevice(device).getCapabilityValue('vasco_control_duration');
  return value !== null && value !== undefined && value === duration;
});
```

- [ ] **Step 5: Verify GREEN and commit**

Run `node --test test/unit/flow-cards.test.js`, followed by `npm test`.

Expected: all Flow tests and the full suite pass.

```bash
git add .homeycompose/flow/conditions/control_duration_is.json app.js test/unit/flow-cards.test.js
git commit -m "feat: add control duration Flow condition"
```

---

### Task 4: Package, security, and physical verification

**Files:**
- Generated by Homey Compose: `app.json`
- Update only if behavior changed during verification: `README.txt`, `README.pl.txt`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: validated install on the selected Homey Pro and physical acceptance evidence.

- [ ] **Step 1: Run complete automated verification**

```bash
npm test
npx homey app build
npx homey app validate --level=debug
npx homey app validate --level=publish
git diff --check
```

Expected: zero test failures, both validations succeed, and no whitespace errors.

- [ ] **Step 2: Run security verification**

Run the Aikido scan over every modified code file when the Aikido MCP server is available. If unavailable, explicitly report that limitation and run the repository's private-artifact/secret-safety tests plus a diff review confirming no credentials, tokens, capture files, email addresses, or raw Vasco identifiers were added.

- [ ] **Step 3: Install on the explicitly selected Homey**

Run `homey select current`, confirm it reports the user's `Homey Pro`, then run `npx homey app install`.

Expected: Homey reports successful installation without removing the paired ventilation device.

- [ ] **Step 4: Verify the three states physically**

Using the existing Homey actions, set one ordinary mode:

1. until next schedule change — device shows `Until next schedule change`;
2. permanently — device shows `Permanent`;
3. for a short timed duration — device shows `Timed`.

Do not perform these reversible state changes without announcing each physical command to the user.

- [ ] **Step 5: Verify the Flow condition**

Create or use a temporary test Flow only with user approval. Confirm `Control duration is Until next schedule change` evaluates true in that state and false in Permanent. Do not leave a test automation that can change ventilation unexpectedly.

- [ ] **Step 6: Commit generated manifest only if changed**

```bash
git add app.json
git commit -m "build: refresh control duration manifest"
```

Skip this commit if Homey Compose leaves `app.json` unchanged or the repository policy excludes generated changes.
