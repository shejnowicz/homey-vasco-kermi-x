# Task 9 — Homey device synchronization and controls report

## Status

Complete. Paired devices now acquire the app-shared account service, synchronize
all supported Homey capabilities, share one account polling loop, execute and
verify supported controls, recover observed state after rejected confirmation,
validate settings before credential replacement, and release their registry
reference on deletion.

## Commit

- `19632e4 feat: synchronize and control Vasco devices`

## RED/GREEN evidence

- Initial RED: `node --test test/unit/vasco-device.test.js` failed because
  `drivers/vasco-kermi-x/device.js` did not exist.
- First implementation run exercised all device paths and reported 8/12 passing.
  The four failures traced to one transition-guard defect: a missing change
  record was `undefined`, which the guard incorrectly treated as non-null.
- First GREEN: after tightening the transition guards, the focused suite passed
  12/12.
- Settings mutation RED: a changed zero-minute duration was accepted while the
  current duration type was `schedule`.
- Final GREEN: local setting validation now checks a changed stored duration
  independently of whether it is active. The focused suite passed 13/13 and
  the full suite passed 74/74.
- Build verification: `homey app build` validated the generated app at debug
  level and completed successfully. `git diff --check` and both `node --check`
  commands also exited successfully.

## Files

- `drivers/vasco-kermi-x/device.js` — lifecycle, app-shared registry creation,
  account-level polling fan-out, capability mapping, availability, verified
  mode and Fireplace-enable commands, observed-state rollback, Maintenance
  Action handling, validated settings updates, cleanup, and the
  `onVascoDeviceTransition(device, event, tokens)` hook reserved for Task 10.
- `test/unit/vasco-device.test.js` — realistic Homey Device double plus focused
  lifecycle, synchronization, command, polling, recovery, settings, rekey,
  secret-redaction, shared-account, and cleanup tests.
- `test/index.js` — includes the device suite in `npm test`.

## Self-review

- Capability writes occur only for changed non-null mapped values, so absent
  optional telemetry retains its last observation instead of fabricating zero.
- Initial synchronization suppresses state transitions. Later mode, Fireplace,
  filter, fault, and availability changes emit stable event IDs through one
  app hook without registering Flow cards ahead of Task 10.
- Multiple devices using one account service share one polling generation and
  receive the same configuration/availability results. The fastest configured
  subscriber interval controls the shared loop, and settings/deletion
  reschedule it when that effective interval changes.
- Mode and Fireplace-enable commands use the established builders and account
  service confirmation read. Confirmed state is applied immediately; a
  rejected confirmation triggers a fresh observed-state read before a fixed,
  redacted user-facing error is returned.
- Credential and local setting validation completes before polling changes.
  Successful account email migration is observed through the service's current
  `accountKey`, so deletion releases the rekeyed registry entry; failed
  validation retains the old service identity and polling schedule.
- Availability thresholds and retry timing remain owned by the account service:
  three transport failures transition devices unavailable, and the next
  successful poll restores availability. The Maintenance Action forces a fresh
  read and uses the same state/availability path.
- Settings objects, upstream errors, credentials, and tokens are never logged
  or interpolated into runtime errors. Tests and fixtures contain synthetic
  values only.

## Concerns

- Fireplace disable remains deliberately unsupported because Task 5 has not
  established a verified Vasco disable payload. The toggle rejects disabling
  without sending a guessed write; Task 10 must omit the disable Flow action
  unless integration evidence becomes available.
- The Aikido MCP server is required for security scanning but was not available
  in this environment. The full secret-safety and unit test suite passed.
- The independent reviewer agent could not be started because the parent thread
  had reached its agent limit. A direct requirement, mutation, security, and
  diff self-review found no additional blocking issue.
