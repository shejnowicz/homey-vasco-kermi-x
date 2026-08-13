# Fireplace Session Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Vasco-compatible Fireplace duration selection, reliable WebSocket activation, a remaining-time display, and safe early stop that restores the prior operating mode.

**Architecture:** Homey Compose exposes a fixed duration enum, status, remaining minutes, and enable/stop buttons. A pure session module owns versioned persisted state and restoration semantics; `device.js` owns Homey timers and UI synchronization. The account service translates the confirmed Fireplace REST object into the observed binary `fireplaceModeTime` WebSocket command and treats `dataWritten` as the physical acknowledgement.

**Tech Stack:** Homey Apps SDK v3, Homey Compose, Node.js 22 CommonJS, built-in WebSocket/TextEncoder, `node:test` and `assert`.

## Global Constraints

- Picker values are exactly `5, 10, 15, …, 85` minutes.
- Never send an invented `fireplaceModeStatus = 0` command.
- Early stop restores the mode and duration semantics captured before Homey enabled Fireplace mode.
- Stale cloud status `1` is suppressed only until the original managed-session deadline.
- Externally started Fireplace mode is active with unknown remaining time; Stop returns a fixed safe error.
- Stored session data contains no credentials, tokens, bridge/device identifiers, or raw Vasco payloads.
- Use `this.homey.setTimeout` and `this.homey.clearTimeout`, never global timers in the Homey device.
- Modify Compose sources, not `app.json`; commit regenerated `app.json` only in the final packaging task.

---

### Task 1: Fireplace UI contract and device migration

**Files:**
- Create: `.homeycompose/capabilities/vasco_fireplace_duration.json`
- Create: `.homeycompose/capabilities/measure_fireplace_remaining.json`
- Modify: `drivers/vasco-kermi-x/driver.compose.json`
- Modify: `drivers/vasco-kermi-x/driver.settings.compose.json`
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/homey-manifest.test.js`
- Modify: `test/unit/vasco-device.test.js`

**Interfaces:**
- Produces: setable enum `vasco_fireplace_duration`; read-only number `measure_fireplace_remaining`; buttons `button.enable_fireplace` and `button.stop_fireplace`.
- Advances `device_contract_version` from `1` to `2`.

- [ ] **Step 1: Write failing Compose tests**

Assert the duration enum contains exactly:

```js
const minutes = Array.from({ length: 17 }, (_, index) => (index + 1) * 5);
assert.deepEqual(duration.values.map(value => Number(value.id)), minutes);
```

Assert the driver orders the picker before both buttons, remaining time is a getable/non-setable integer number in minutes, `button.stop_fireplace` has bilingual title/description, and `default_fireplace_minutes` is absent from settings.

- [ ] **Step 2: Verify RED**

Run: `node --test test/unit/homey-manifest.test.js`

Expected: FAIL because the picker, remaining capability, and Stop button do not exist.

- [ ] **Step 3: Implement the Compose files**

Create the exact enum and numeric capability. Add `vasco_fireplace_duration`, `measure_fireplace_remaining`, and `button.stop_fireplace` to the driver. Keep `vasco_fireplace` read-only. Remove the old free-form setting.

- [ ] **Step 4: Write failing migration tests**

Extend existing migration tests: version `1` adds the two new custom capabilities and Stop button, copies a valid old `default_fireplace_minutes` rounded to the nearest supported picker value (clamped to 5–85) into `vasco_fireplace_duration`, and stores version `2`. Version `2` must preserve the user's picker value. The old value may remain as hidden legacy device data because the Homey Device API has no setting-deletion method.

- [ ] **Step 5: Implement idempotent migration**

Update `ensureDeviceContract()` and the Homey test double. Default to `5` when no valid legacy value exists. Capability additions and store version write remain fail-fast and idempotent; runtime code no longer reads the hidden legacy setting.

- [ ] **Step 6: Verify and commit**

Run:

```bash
node --test test/unit/homey-manifest.test.js
node --test --test-name-pattern='device contract|Fireplace duration migration' test/unit/vasco-device.test.js
npx homey app validate --level=debug
```

Commit:

```bash
git add .homeycompose/capabilities/vasco_fireplace_duration.json .homeycompose/capabilities/measure_fireplace_remaining.json drivers/vasco-kermi-x/driver.compose.json drivers/vasco-kermi-x/driver.settings.compose.json drivers/vasco-kermi-x/device.js test/unit/homey-manifest.test.js test/unit/vasco-device.test.js
git commit -m "feat: add Fireplace duration and stop controls"
```

### Task 2: Confirmed Fireplace WebSocket transport

**Files:**
- Modify: `lib/vasco-account-service.js`
- Modify: `lib/vasco-command-builder.js`
- Modify: `test/unit/vasco-account-service.test.js`
- Modify: `test/unit/vasco-command-builder.test.js`
- Modify: `test/unit/vasco-websocket-client.test.js`

**Interfaces:**
- Consumes: `buildFireplaceEnableCommand(raw, { minutes })` with validated integer minutes.
- Produces: WebSocket write `{ parameterName: 'fireplaceModeTime', value: minutes, expectedFunctionName: 'dataWritten', expectedParameter: 'fireplaceModeTime', expectedValue: minutes }`.

- [ ] **Step 1: Write failing protocol tests**

Test a Fireplace command performs REST sync and one binary WebSocket `writeData` for `fireplaceModeTime`, without shifting `minutes`. Assert the optimistic returned state has `fireplaceModeStatus: 1` and the selected time. Retain tests proving mode commands still use their distinct mapping.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='Fireplace.*WebSocket|fireplaceModeTime' test/unit/vasco-account-service.test.js test/unit/vasco-websocket-client.test.js`

Expected: FAIL because the account service currently creates physical writes only for `requestedLevel`.

- [ ] **Step 3: Implement the Fireplace transport branch**

After REST succeeds, detect the validated Fireplace enable command and call `writeDeviceParameter` with the exact observed fields. On `dataWritten`, create an acknowledged state from the command with `fireplaceModeStatus = 1`; return it when the caller's confirmation accepts it. Do not add unknown properties to the raw object sent to Vasco.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test test/unit/vasco-account-service.test.js test/unit/vasco-command-builder.test.js test/unit/vasco-websocket-client.test.js
npm test
```

Commit the five scoped files with `git commit -m "fix: activate Fireplace mode through Vasco WebSocket"`.

### Task 3: Pure Fireplace session model

**Files:**
- Create: `lib/vasco-fireplace-session.js`
- Create: `test/unit/vasco-fireplace-session.test.js`

**Interfaces:**
- Produces:
  - `createManagedSession(state, minutes, nowMs)`
  - `parseStoredSession(value, nowMs)`
  - `remainingMinutes(session, nowMs)`
  - `restorationRequest(session, nowMs)`
  - `stoppedSession(session)`
  - `effectiveFireplaceState(rawActive, session, nowMs)`

- [ ] **Step 1: Write failing tests for creation and validation**

Cover supported picker minutes, versioned JSON-safe output, capture of mode/control semantics, rejection of sensitive or malformed data, and expiry parsing. The stored object may contain only `version`, `priorMode`, `priorDuration`, `selectedMinutes`, `startedAt`, `endsAt`, `stoppedAt`, and `suppressUntil`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/unit/vasco-fireplace-session.test.js`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement creation, parsing, and remaining time**

Use literal millisecond arithmetic. `remainingMinutes` returns `Math.ceil((endsAt - nowMs) / 60_000)` clamped to zero. Invalid/expired unmanaged data returns `null`, not a partially trusted session.

- [ ] **Step 4: Add failing restoration tests**

Cover permanent, schedule, active timed override (remaining whole minutes, minimum one), and expired timed override (schedule). Cover `stoppedSession` preserving `endsAt` as `suppressUntil` and effective-state suppression only before that deadline.

- [ ] **Step 5: Implement restoration and suppression**

Return requests compatible with `buildModeCommand`: `{ mode, duration, nowMs? }`. Never create a Fireplace disable command.

- [ ] **Step 6: Verify and commit**

Run: `node --test test/unit/vasco-fireplace-session.test.js`

Commit with `git commit -m "feat: model persisted Fireplace sessions"`.

### Task 4: Homey session lifecycle, countdown, and Stop

**Files:**
- Modify: `drivers/vasco-kermi-x/device.js`
- Modify: `test/unit/vasco-device.test.js`

**Interfaces:**
- Consumes all Task 3 session functions.
- Store key: `fireplace_session`.
- Device timer property: `fireplaceTimer`.

- [ ] **Step 1: Extend the Homey test double and write failing initialization tests**

Add `homey.setTimeout`, `homey.clearTimeout`, store support, and deterministic clock behavior. Test restoration of an active managed session after restart, removal of malformed data, and external active state with `measure_fireplace_remaining = null`.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='Fireplace session|remaining time' test/unit/vasco-device.test.js`

Expected: FAIL because the device has no session lifecycle.

- [ ] **Step 3: Implement initialization and countdown scheduling**

Load/parse `fireplace_session` before initial state application. Register listeners for duration picker, enable, and stop. Schedule one Homey timeout to the next minute boundary, update `measure_fireplace_remaining`, and reschedule until zero. Clear the timer on deletion and uninitialization.

- [ ] **Step 4: Write failing enable tests**

Test picker `45` records prior state, persists the managed session before the command, sends Fireplace 45, applies active status and remaining time, and rolls back session/timer/UI if the command fails.

- [ ] **Step 5: Implement managed enable**

Replace the old settings-based duration lookup with the picker capability. Serialize store and capability writes through the existing state queue. Keep the existing fixed public error and redacted diagnostics.

- [ ] **Step 6: Write failing Stop tests**

Cover restoration of prior permanent/schedule/timed modes, success clearing countdown and suppressing stale raw status, failed Stop retaining session/countdown, and external activation returning a fixed explanatory error without sending a command.

- [ ] **Step 7: Implement Stop and effective status mapping**

Call the ordinary mode command using `restorationRequest`. On success persist `stoppedSession`, clear remaining time, and map stale cloud status through `effectiveFireplaceState`. Remove suppression when raw status becomes zero or deadline passes.

- [ ] **Step 8: Verify and commit**

Run:

```bash
node --test test/unit/vasco-device.test.js
npm test
```

Commit with `git commit -m "feat: manage and stop Fireplace sessions"`.

### Task 5: Flow compatibility and public copy

**Files:**
- Modify: `.homeycompose/flow/actions/enable_fireplace_for_minutes.json`
- Modify: `locales/en.json`
- Modify: `locales/pl.json`
- Modify: `README.txt`
- Modify: `README.pl.txt`
- Modify: `test/unit/homey-manifest.test.js`
- Modify: `test/unit/publish-readiness.test.js`

**Interfaces:**
- Keeps the existing Flow action accepting explicit whole minutes in its current validated range.
- Documents that remaining time is exact only for Homey-started sessions and Stop restores the prior mode.

- [ ] **Step 1: Write failing contract/copy tests**

Assert the Flow action remains present with its numeric duration argument and bilingual copy. Assert public descriptions mention the picker and safe restoration without claiming an undocumented direct disable command.

- [ ] **Step 2: Verify RED**

Run: `node --test test/unit/homey-manifest.test.js test/unit/publish-readiness.test.js`

- [ ] **Step 3: Update copy without changing Flow behavior**

Keep Flow duration validation unchanged. Add concise English and Polish text explaining device picker, known remaining time, and restore behavior. Do not mention reverse-engineering internals or private endpoints in Store copy.

- [ ] **Step 4: Verify and commit**

Run focused tests and commit with `git commit -m "docs: explain Fireplace session behavior"`.

### Task 6: Full verification and X500 smoke test

**Files:**
- Modify generated output only: `app.json`

**Interfaces:**
- Verifies the complete feature on the paired X500 without exposing private artifacts.

- [ ] **Step 1: Run automated verification**

```bash
npm test
npx homey app validate --level=debug
npx homey app validate --level=publish
git diff --check
```

Expected: all tests and both validation levels pass.

- [ ] **Step 2: Run security verification**

Run Aikido full scan on all modified code files. If the MCP remains unavailable, explicitly report it and run the repository secret/private-artifact tests as fallback.

- [ ] **Step 3: Regenerate and commit Compose output**

Run validation, verify `app.json` contains only generated changes corresponding to Compose, and commit it with `git commit -m "build: refresh Fireplace Homey manifest"` when changed.

- [ ] **Step 4: Install on Homey**

Run: `npx homey app install`

Expected: existing `rekuperator` remains paired and available.

- [ ] **Step 5: Physical 5-minute test**

With a normal mode active, select 5 minutes and press Enable. Verify physical behavior, status, and countdown. Before expiry press Stop. Verify the prior mode is restored physically and in both Homey and Vasco, remaining time clears, and stale raw Fireplace status does not reactivate the Homey UI.

- [ ] **Step 6: Picker contract smoke test**

Open the picker and confirm values 5–85 in five-minute increments. Do not start long sessions. Restart the Homey app during a new 5-minute session and confirm countdown restoration, then stop it.
