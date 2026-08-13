# Direct Fireplace Control Design

## Goal

Make Fireplace mode behave like the Vasco mobile application. Homey sends the
selected duration to enable the mode and sends zero minutes to request that
Vasco stop it. Homey does not emulate cancellation or maintain a second local
Fireplace session state.

## User experience

The device screen retains:

- the `Fireplace duration` picker with Vasco's 5–85 minute values;
- `Enable Fireplace mode`;
- `Stop Fireplace mode`;
- the read-only `Fireplace mode active` status.

The `Fireplace time remaining` field is removed because Vasco does not expose a
reliable remaining-time value. Starting Fireplace mode does not change the
operating-mode picker or promise that Homey can restore the previous mode.

## Commands and state

Enable sends `fireplaceModeTime` with the selected number of minutes. Stop sends
the same Vasco WebSocket property with the value `0`, matching the captured
mobile-app request. A successful `dataWritten` acknowledgement means Vasco
accepted the write. It does not prove that the current X500 firmware applied the
requested cancellation.

The displayed Fireplace status always comes from Vasco's
`fireplaceModeStatus`. Homey does not optimistically force it to false, suppress
a still-active upstream status, restore a prior operating mode, or calculate a
local expiry. If Vasco acknowledges zero but continues reporting an active
Fireplace mode, Homey continues showing it as active.

## Removed local session machinery

Remove the persisted Homey-started Fireplace session, countdown timer,
remaining-minute calculation, previous-mode snapshot, restoration request, and
stale-status suppression. App restart therefore has no Fireplace session to
restore; the first normal Vasco read supplies the current status.

The public Flow action for enabling Fireplace mode remains unchanged. There is
currently no public Stop Flow action, so this change affects the device button
only.

## Compatibility and migration

Advance the device contract version and idempotently remove
`measure_fireplace_remaining` from already-paired devices. Remove the capability
from the driver manifest for new pairings. Preserve the duration picker and both
buttons. Any obsolete persisted Fireplace session value is deleted during
migration and is never read again.

## Error handling

Authentication, transport, protocol, and negative WebSocket acknowledgement
failures produce a fixed, credential-safe Homey error. A positive `dataWritten`
acknowledgement completes the button action even when a subsequent status read
still reports Fireplace mode active. Normal polling reconciles the visible
status without local overrides.

## Verification

Automated tests cover:

- enable writes each supported 5–85 minute value;
- Stop writes exactly zero minutes;
- positive and negative WebSocket acknowledgement handling;
- status synchronization exclusively from `fireplaceModeStatus`;
- removal of the local session, countdown, suppression, and restoration paths;
- migration of an existing device and cleanup of obsolete stored session data;
- absence of `measure_fireplace_remaining` from generated manifests;
- Homey debug and publish validation.

Physical verification on the X500 checks that Enable matches the Vasco app,
Stop emits zero minutes, and Homey continues to show Vasco's actual reported
status if firmware version 26 does not cancel the mode.
