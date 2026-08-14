# Fireplace session controls design

## Goal

Provide complete, honest Fireplace-mode controls in the Homey device UI: select the same duration choices as the Vasco app, enable the mode, display its remaining time when known, and stop it early by restoring the prior operating mode.

## Confirmed Vasco protocol

The official app enables Fireplace mode with a binary WebSocket `writeData` message:

- `parameterName`: `fireplaceModeTime`
- `data`: selected minutes
- device `modbusAddress`, `swVersion`, and `productType`

The gateway acknowledges with `dataWritten(fireplaceModeTime)` and then emits `valueChanged(fireplaceModeStatus, 1)`. The duration value is not shifted.

There is no observed Fireplace-disable command. The official app ends the effective Fireplace behavior by selecting an ordinary ventilation mode. The cloud may continue reporting `fireplaceModeStatus = 1` until the original Fireplace timer expires. The Homey app must not invent or send `fireplaceModeStatus = 0`.

## Device UI

The device exposes:

- a duration picker with exactly `5, 10, 15, …, 85` minutes;
- `Enable Fireplace mode` / `Włącz tryb kominka` button;
- `Stop Fireplace mode` / `Zakończ tryb kominka` button;
- read-only effective Fireplace status;
- read-only remaining-time value in minutes.

The old free-form default Fireplace duration setting is removed after existing-device migration because the picker becomes the single device-UI source of duration. Flow actions continue accepting an explicit validated duration.

## Starting a Homey-managed session

Before enabling Fireplace mode, the device records:

- current standard mode;
- its control duration semantics: permanent, until next schedule change, or remaining timed override;
- selected Fireplace duration;
- session start and end timestamps.

The app sends the REST synchronization required by the existing account service and the confirmed WebSocket `fireplaceModeTime` write. It waits for `dataWritten`, applies effective Fireplace status immediately, starts the remaining-time display, and lets normal polling reconcile cloud state.

The selected duration persists as a user preference. A Homey restart restores a non-expired session and its countdown from the device store.

## Remaining time

For a Homey-managed session, remaining minutes are calculated from the persisted end timestamp using the Homey clock and rounded up. The display updates at minute boundaries using `this.homey.setTimeout`; no global timer is used. At zero, the local session ends and a forced cloud refresh reconciles the final state.

If Fireplace mode was started outside Homey, the app shows it as active but reports remaining time as unknown (`null`). Vasco exposes the selected duration but not a reliable start timestamp, so the app must not present an estimate as exact.

## Stopping early

The Stop button can complete only for a Homey-managed session with a recorded prior mode. Homey buttons cannot be disabled dynamically, so pressing it without such a session returns a fixed explanatory error. For a managed session, it sends the ordinary mode command for the recorded mode and restores the recorded duration semantics:

- permanent returns as permanent;
- schedule returns until the next schedule event;
- a timed override returns for its remaining whole minutes, with a minimum of one minute;
- an already expired timed override returns to schedule control.

After the ordinary mode command is acknowledged, Homey marks the effective Fireplace status inactive, clears the remaining time, cancels the countdown, and persists a suppression deadline equal to the original Fireplace end time. While this deadline is active, stale cloud `fireplaceModeStatus = 1` does not reactivate the Homey status. Polling still updates all other device fields. The suppression state survives a Homey restart and is removed when the deadline passes or the cloud reports status `0`.

For an externally started Fireplace session, Stop returns the explanatory error because there is no trustworthy prior mode snapshot. The user can select an ordinary mode explicitly, matching the official Vasco behavior.

## State and storage

Persist a versioned, non-sensitive Fireplace session object in the device store. It contains only mode, duration type, relevant timestamps, selected minutes, and suppression deadline. It contains no account credentials, tokens, bridge identifiers, or raw Vasco payloads.

Malformed, unsupported, or expired stored session data is discarded safely during initialization.

## Error handling

- Reject durations outside the picker/Flow validation range before sending a command.
- A WebSocket timeout or rejection leaves the previous mode snapshot intact only for retry and does not show an active Homey session.
- A failed Stop command keeps the session active and the countdown running.
- Capability and device-store writes remain serialized with the existing state queue.
- Public errors remain fixed and redact private account/device data.

## Verification

Automated tests cover:

- exact picker values from 5 through 85 in steps of 5;
- WebSocket binary framing for `fireplaceModeTime` without value shifting;
- `dataWritten` acknowledgement and immediate effective status;
- prior-mode capture for permanent, schedule, active timed, and expired timed states;
- countdown rounding, minute-boundary scheduling, completion, restart restoration, and malformed-store recovery;
- successful and failed Stop behavior;
- suppression of stale cloud status until the original deadline;
- external Fireplace activation showing active with unknown remaining time and a safe Stop error;
- no credentials, tokens, identifiers, or raw payloads in stored/session diagnostics;
- full suite, Homey validation, and physical X500 verification.

Physical verification uses a 5-minute session: enable from Homey, observe countdown and fan behavior, stop early, confirm restoration of the prior mode, and confirm the official Vasco app reflects the ordinary mode. Longer picker values are contract-tested without running twelve-hour sessions.
