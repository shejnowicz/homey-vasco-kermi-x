# Fireplace Toggle Design

## Goal

Replace the separate Fireplace Enable and Stop buttons with one stateful switch
that both controls Fireplace mode and displays Vasco's actual reported state.

## User experience

The device screen retains the `Fireplace duration` picker and replaces
`Enable Fireplace mode` plus `Stop Fireplace mode` with one
`Fireplace mode active` switch.

- Switching ON sends the duration currently selected in the 5–85 minute picker.
- Switching OFF sends `fireplaceModeTime: 0`.
- The switch position reflects `fireplaceModeStatus` reported by Vasco.

The switch uses the existing custom `vasco_fireplace` capability. It does not
use Homey's system `onoff` capability because that would imply powering the
whole ventilation unit. The device tile continues showing the operating-mode
number and is not repurposed as a Fireplace power tile.

## State authority and failed cancellation

Homey does not optimistically claim that the requested state was applied. A
positive `dataWritten` acknowledgement completes the write, after which the
capability remains aligned with the Vasco state returned by the command and
normal polling.

Physical X500 firmware version 26 testing confirmed that a zero-minute write is
acknowledged but does not deactivate Fireplace mode. In that case the Homey
switch remains or returns ON, accurately showing Vasco's continuing active
status. This is expected behavior, not a Homey command error.

## Device contract migration

Change `vasco_fireplace` from a read-only sensor to a getable and setable toggle.
Remove `button.enable_fireplace` and `button.stop_fireplace` from the driver
manifest. Advance the device contract version and idempotently remove both
button capabilities from already-paired devices before registering the toggle
listener. Existing `vasco_fireplace` values and the duration picker are
preserved.

The existing Enable Fireplace Flow action remains available and continues to
accept its explicit duration. No Stop Flow action is added in this change.

## Runtime behavior

Register one listener for `vasco_fireplace`:

- `true` calls the existing direct Fireplace write with the selected picker
  duration;
- `false` calls the existing direct Fireplace write with zero minutes.

The direct command layer, WebSocket acknowledgement rules, polling, transition
triggers, fixed credential-safe errors, and no-local-session architecture remain
unchanged.

## Verification

Automated tests cover:

- capability metadata declares a getable/setable toggle;
- both button capabilities are absent from Compose and generated manifests;
- migration removes both buttons while preserving the toggle and picker;
- ON sends the selected duration and OFF sends zero;
- acknowledged OFF with Vasco still active leaves the capability true;
- the existing Enable Flow action remains unchanged;
- full tests plus Homey debug and publish validation.

Physical verification checks ON and OFF once. The accepted result on X500
firmware 26 is that ON activates Fireplace mode and OFF completes without a
Homey error while the switch remains ON if Vasco still reports the mode active.
