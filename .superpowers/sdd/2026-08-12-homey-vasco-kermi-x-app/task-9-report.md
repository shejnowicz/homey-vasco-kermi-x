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

## Fix round 1

The independent review identified four blocking integration issues: shared
credential changes mutated every subscriber while only one device persisted
the replacement, asynchronous state callbacks could interleave or continue
after deletion, per-device mapping failures were swallowed while account
availability returned true, and failed initialization or an empty polling
coordinator could retain account resources.

Adversarial tests reproduced all four issues. The first focused RED run passed
12/19 tests and failed the seven new assertions. The implementation now:

- serializes capability and availability mutations per device and suppresses
  remaining writes and transitions after deletion;
- treats a successful poll as recovery only after that device applies the
  configuration, while a missing or malformed device becomes unavailable;
- serializes shared-account settings changes, stops the old polling generation
  after credential commit, persists replacement credentials to every active
  subscriber, and rolls the service and already-updated siblings back when
  persistence fails;
- releases every acquired reference when initialization fails and explicitly
  stops polling when the last subscriber leaves the coordinator.

The focused suite then passed 19/19. A further stale-poll race test failed
19/20 before the old generation was stopped at credential commit and passed
20/20 afterward. Fresh verification passed the full suite at 81/81,
`homey app build`, both `node --check` commands, and `git diff --check`.
Fireplace disable remains blocked without issuing a cloud write. The Aikido MCP
server remains unavailable, so the required external security scan could not
be run.

## Fix round 2

A fresh review found that a queued credential update retained the
`oldSettings` snapshot from the time it was requested rather than the committed
shared credentials at the time it executed. If update X succeeded and queued
update Y later failed, Y could therefore compensate the service back to the
original credentials instead of X. The same review found that failed service
or sibling-setting compensation was swallowed, after which polling resumed and
the caller was incorrectly told that settings had not changed.

Three adversarial tests reproduced the stale-baseline case, failed service
compensation, and failed sibling compensation. The focused RED run passed
20/23 and failed those three assertions. Account coordinators now retain a
non-enumerable committed credential baseline that is read only inside the
serialized settings operation. Successful commits advance it; successful
compensation restores it.

Compensation now reports whether both the service and every active sibling were
restored. An incomplete recovery stops polling, marks all affected devices
unavailable with a redacted authentication message, and returns a truthful
fixed error asking the user to re-enter credentials. Interval changes cannot
restart polling while recovery is required; a subsequent successful shared
credential replacement clears recovery and resumes polling at the current
effective interval. The focused suite passed 23/23 and fresh verification
passed the full suite at 84/84, `homey app build`, both `node --check`
commands, and `git diff --check`. The Aikido MCP server remained unavailable.

## Fix round 3

A further security review found that the polling coordinator retained a raw
password in its long-lived committed-credential baseline. Making that property
non-enumerable prevented accidental diagnostics but did not satisfy the Task 6
secret-lifetime boundary.

The focused RED run passed 42/45. The three new failures showed that the
account service did not yet provide an opaque rollback operation, the device
did not discard successful rollback state, and failed sibling persistence
still attempted raw credential replacement from device-owned state.

`VascoAccountService.updateCredentials()` now returns a one-use opaque handle.
Only the service retains the previous credentials, and the handle clears them
before rollback or when `discard()` is called. The device coordinator no longer
contains credentials or passwords. Successful settings transactions discard
the handle immediately; failed transactions invoke its opaque rollback while
preserving the concurrent-update and incomplete-recovery behavior from fix
round 2.

The focused service/device suites passed 45/45 and fresh full verification
passed 87/87. `homey app build`, syntax checks, and `git diff --check` also
passed. The Aikido MCP server remained unavailable.
