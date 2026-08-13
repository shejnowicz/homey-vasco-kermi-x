# Control Duration Status Design

## Goal

Expose how long the current Vasco operating-mode command applies and make that state usable as a Homey Flow condition. This lets Homey schedules act only while Vasco is in the "until next schedule change" state, while a permanent manual selection continues to block those schedules.

## User experience

The paired ventilation device gains a read-only `Control duration` / `Sposób sterowania` enum shown on the device screen. It has exactly three values:

- `Until next schedule change` / `Do następnej zmiany harmonogramu`;
- `Permanent` / `Na stałe`;
- `Timed` / `Czasowo`.

Homey Flow gains one device condition card:

`Control duration is [Until next schedule change | Permanent | Timed]`

The condition supports Homey's normal inverted form. No new trigger is added in this feature.

An intended Flow is:

- When: it is 00:00;
- And: Control duration is Until next schedule change;
- Then: set operating mode to Medium until the next schedule change.

## State derivation

A focused pure mapper derives the Homey value from Vasco state:

- `controlMode === "schedule"` and `manualSettingActiveTill === 0` maps to `until_schedule`;
- `manualSettingActiveTill === -1` maps to `permanent`;
- `controlMode === "manual"` and a future `manualSettingActiveTill` timestamp maps to `timed`.

Malformed, contradictory, or expired values map to `null`. A `null` mapping is not written over the last valid Homey capability value, and the Flow condition evaluates to false for an unavailable or unknown value. The normal Vasco polling and command-confirmation paths update the capability; this feature does not invent a local expiry transition because the mode to which a timed command returns is owned by Vasco.

## Compatibility and migration

The new capability ID is `vasco_control_duration`. The existing `vasco_control_state` capability and `manual_override_is_active` Flow condition remain unchanged to avoid breaking paired devices or existing Flows.

The device contract migration advances to version 3 and idempotently adds `vasco_control_duration` to already-paired devices before listeners and account polling start. New pairings receive it from the driver manifest.

## Flow integration

The new condition card ID is `control_duration_is`. It takes a device argument supplied by Homey and a dropdown argument named `duration` containing the three stable IDs. Its run listener compares the requested ID with `device.getCapabilityValue("vasco_control_duration")` and returns a boolean without contacting Vasco.

## Error handling

No new user credentials, network calls, or writable commands are introduced. Unknown upstream values remain non-destructive: the previous valid display value is retained and condition checks for unmatched values return false. Migration failure rejects device initialization rather than leaving a partially updated contract.

## Verification

Automated tests cover:

- all three valid mappings plus malformed, contradictory, and expired inputs;
- Homey Compose metadata, bilingual labels, stable enum IDs, driver ordering, and Flow card arguments;
- version-2-to-version-3 migration and version-3 idempotence;
- initial synchronization and optimistic post-command synchronization;
- the condition listener's true, false, and unknown-state behavior, with inversion delegated to Homey;
- full unit suite, Homey debug validation, and Homey publish validation.

Physical verification confirms that the device screen changes among all three states after issuing the existing Homey actions and that a test Flow condition follows the displayed state.
