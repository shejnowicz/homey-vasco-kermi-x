# Homey device controls and tile indicator design

## Scope

Improve the Vasco/Kermi ventilation device presentation in Homey without changing the confirmed cloud control protocol. The change covers the default duration explanation, Fireplace controls, and a numeric operating-mode tile indicator.

## Default control duration

New devices use `schedule` (`Until next schedule change`) as `default_duration_type`.

The setting includes an English and Polish hint explaining that:

- the setting controls changes made from the device's operating-mode picker;
- `Until next schedule change` lets the next Vasco schedule event resume control;
- Flow action cards can still explicitly select permanent, until-schedule, or timed control.

Existing pre-release devices receive a one-time migration to `schedule`. A persistent migration marker prevents future app starts from overwriting a user's later choice.

## Fireplace controls

The current writable `vasco_fireplace` toggle is misleading because disabling Fireplace mode has not been reverse-engineered and verified.

The device UI will expose:

- `vasco_fireplace` as a read-only status named `Fireplace mode active` / `Tryb kominka aktywny`;
- `button.enable_fireplace` as a push button named `Enable Fireplace mode` / `Włącz tryb kominka`.

Pressing the button uses the configured `default_fireplace_minutes`. Existing Flow cards remain available. Capability migration runs only when required and does not delete the read-only Fireplace state.

## Numeric tile indicator

Add a read-only numeric measurement capability named `Operating mode number` / `Numer trybu pracy`. It mirrors the Vasco level without remapping:

| Mode | Indicator |
|---|---:|
| Low | 1 |
| Medium | 2 |
| High | 3 |
| Auto | 4 |
| Holidays | 6 |
| Guests | 7 |

The capability uses integer values and no unit. It is eligible for Homey's device tile indicator selector. Homey controls the user's tile-indicator preference, so the app will not claim it can force the selection. If Homey does not select it automatically, the user selects it once in the device tile indicator settings.

The value is updated through the same serialized state-application path as `vasco_mode`, including optimistic WebSocket acknowledgement and later polling reconciliation.

## Migration and failure handling

On initialization, the driver ensures the new button and numeric capability exist. Migration is idempotent. A failed capability or settings migration is logged and fails device initialization rather than leaving partially registered controls.

The one-time default-duration migration uses a device store marker. After the marker is written, future starts preserve the user's chosen duration.

## Verification

Automated tests cover:

- bilingual setting hint and default value;
- one-time duration migration and preservation after migration;
- removal of writable Fireplace behavior and registration of the explicit button;
- button use of the configured Fireplace duration;
- numeric capability mapping for all six supported modes;
- capability migration idempotency;
- full test suite and Homey manifest validation.

Physical verification on the X500 checks the Fireplace button UI presentation and the tile indicator selection/display. No Fireplace command is sent unless the user explicitly presses the button.
