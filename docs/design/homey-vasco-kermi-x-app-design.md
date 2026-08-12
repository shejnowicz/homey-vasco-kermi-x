# Homey Vasco/Kermi X Series App — Design

## Goal

Build a professional, community-maintained Homey app for Vasco/Kermi X Series ventilation units. The app will be developed publicly in `shejnowicz/homey-vasco-kermi-x`, prepared for eventual Homey App Store submission, and initially validated against a Vasco X500 (`VMD-17RPS01`). Other X Series models are expected to use the same cloud API but must be community-verified.

The first release will use the reverse-engineered Vasco cloud REST API. It will support monitoring, operating-mode control, timed overrides, fireplace mode, pairing multiple units, and Homey Flow cards.

## Product identity and compatibility

- Repository: `shejnowicz/homey-vasco-kermi-x`
- Local project directory: `~/projects/homey-vasco-kermi-x`
- Homey App ID: `com.shejnowicz.vasco-kermi-x`
- App name: `Vasco/Kermi X Series`
- One driver: `Vasco/Kermi X Series Ventilation Unit`
- Base language: English
- Included translation: Polish
- Explicit compatibility statement: developed and tested on Vasco X500; other Vasco/Kermi X Series models are expected to work but require verification.

The driver will not filter exclusively for the X500 product code. Pairing will identify ventilation-category devices and validate that their API objects contain the properties required by the app. Unsupported structures will be rejected safely rather than controlled speculatively.

## Architecture

The implementation will be REST-first and modular, with a transport boundary that permits a later MQTT implementation without rewriting the Homey driver.

### `VascoApiClient`

Owns the low-level cloud protocol:

- login through `POST /api/login`,
- account reads through `POST /api/getaccountconfiguration`,
- device writes through `POST /api/setdeviceproperties`,
- nested JSON serialization required by Vasco,
- request timeouts and safe error classification,
- no logging of request or response bodies containing secrets.

### `VascoAccountService`

Owns one in-memory session per Vasco account:

- shares login and configuration polling between all paired units on that account,
- caches `userToken` only in memory,
- coalesces concurrent configuration reads,
- automatically reauthenticates when a token is rejected,
- retries the original operation once after successful reauthentication,
- applies exponential backoff to cloud and authentication failures,
- prevents repeated login attempts from locking an account.

Credentials are persisted only in protected Homey device settings. They are never stored in source files, fixtures, application logs, crash messages, or version control. Multiple paired devices may contain the same protected account credentials, but their runtime requests use the shared account service.

### `VascoDeviceMapper`

Owns discovery and state interpretation:

- enumerates all bridges and ventilation devices returned by account configuration,
- derives a stable internal identity from the gateway and device identifiers,
- excludes devices already paired with Homey,
- validates the minimum supported property contract,
- maps supported API properties to typed domain state,
- omits private account, bridge, network, serial, and token fields from diagnostics.

### `VascoCommandBuilder`

Builds writes defensively:

- starts with a freshly read complete device object,
- changes only an explicit allowlist of fields,
- preserves unknown fields needed by the Vasco API,
- serializes the full object array required by `setdeviceproperties`,
- serializes commands per ventilation unit so writes cannot overlap,
- performs a fresh read after every write and verifies the requested state.

### Homey driver and devices

The single driver handles pairing, device capabilities, settings, polling, availability, and Flow cards. Each paired Homey device represents one physical ventilation unit. Polling is scheduled at account level and distributed to all relevant devices.

MQTT is explicitly outside the first release. The REST transport abstraction will allow push updates to be added later.

## Pairing

1. The user selects the `Vasco/Kermi X Series Ventilation Unit` driver.
2. The user enters their Vasco email address and password.
3. Homey logs in and fetches the account configuration.
4. The driver enumerates all compatible ventilation units across all gateways.
5. Each result uses the Vasco-defined friendly name when available and includes the technical product model as secondary information.
6. The user may select one or multiple units.
7. Units already paired, based on stable gateway-plus-device identity, are omitted.
8. Each newly paired device performs an initial state read and joins the account polling schedule.

If a candidate does not expose the required contract, pairing displays its model and directs the user to report compatibility data through GitHub. Error messages must not contain private identifiers or raw API responses.

## Device capabilities and user experience

The device detail view exposes:

- operating mode: Low, Medium, High, Auto, Holidays, or Guests,
- indoor temperature,
- outdoor temperature,
- supply fan speed,
- exhaust fan speed,
- bypass position,
- control state: Schedule or Manual override,
- manual override end time when applicable,
- fireplace mode,
- filter warning,
- fault state,
- defrost state,
- RF communication problem.

Values absent on a particular model are unavailable or hidden; missing values must never be represented as a fabricated zero.

`Controller` mode is excluded from the first release because the tested X500 did not confirm activation after receiving level 5.

### Control from the device view

The operating-mode selector contains Low, Medium, High, Auto, Holidays, and Guests. Changes from the device view use the configured default control duration:

- Until next schedule change — default,
- Permanently,
- For a specified duration.

When the specified-duration option is selected, a second setting supplies the default duration in minutes. It defaults to 60 minutes and accepts whole values from 1 to 1440 minutes.

Fireplace is independent of the standard level API. It has a separate switch and a configurable default duration. The duration defaults to the integration-tested value of 5 minutes and accepts whole values from 1 to 1440 minutes. Switching it on sends `fireplaceModeStatus: 1` and the selected duration through `fireplaceModeTime`.

Every command is followed by an immediate state read. If Vasco does not confirm the requested change, the device UI returns to the observed state and the operation fails with a user-facing error.

## Device settings

- Polling interval: 30 seconds, 60 seconds, 2 minutes, 5 minutes, or 10 minutes; default 60 seconds.
- Default control duration: Until next schedule, Permanently, or Specified duration.
- Default specified duration in minutes.
- Default fireplace duration in minutes.
- Vasco email.
- Vasco password.
- Test connection Homey Maintenance Action.

Changing account credentials validates the new credentials before the device resumes normal operation. Settings and error views use English source strings with Polish translations.

## Sessions and authentication failures

The API token lifetime is unknown, so token expiry is treated as routine:

1. A rejected token invalidates the in-memory session.
2. The account service performs one shared reauthentication.
3. The failed read or command is retried once.
4. Successful transparent reauthentication does not notify the user.

If reauthentication fails, devices on that account become unavailable with an actionable authentication message. Homey Timeline receives one deduplicated notification instructing the user to update Vasco credentials. Further attempts use exponential backoff. After credentials are corrected and `Test connection` succeeds, affected devices become available automatically.

## Polling and availability

REST polling is the source of external state changes. The default interval is 60 seconds and is configurable using the safe preset list. Devices on the same account share configuration reads even if more than one unit is paired.

Commands trigger an immediate verification read independently of the regular polling timer. Polls do not overlap; a slow request is reused or skipped rather than queued indefinitely.

Temporary cloud failures retain the last known capability values and mark data as stale internally. Three consecutive failed polling cycles mark the device unavailable. Retry backoff starts at 30 seconds, doubles after each failure, and is capped at 30 minutes. A successful poll resets the failure counter and marks the device available again. Authentication rejection after the single reauthentication attempt marks the device unavailable immediately because user action is required.

The first release depends on internet connectivity and the availability of the Vasco cloud service.

## Flow cards

### Actions

- Set operating mode to `[mode]` until the next schedule change.
- Set operating mode to `[mode]` permanently.
- Set operating mode to `[mode]` for `[minutes]`.
- Enable fireplace mode for `[minutes]`.
- Disable fireplace mode.
- Refresh device state.

### Conditions

- Operating mode is `[mode]`.
- Fireplace mode is active.
- Manual override is active.
- Filter requires attention.
- Fault is present.
- Defrost is active.

### Triggers

- Operating mode changed, with previous-mode and new-mode tokens.
- Fireplace mode enabled.
- Fireplace mode disabled.
- Filter warning appeared.
- Fault appeared.
- Fault cleared.
- Device became unavailable.
- Device became available.

The first successful read after application startup initializes state without firing change triggers. Triggers fire only for observed transitions after initialization.

Example:

```text
When: Kitchen hood turned off
And:  Vasco/Kermi X operating mode is not High
Then: Set operating mode to High for 30 minutes
```

The time is delegated to the ventilation unit through `manualSettingActiveTill`; no Homey timer is required to restore the Vasco schedule.

## Command encoding

Standard operating levels use:

| Mode | `requestedLevel` |
|---|---:|
| Low | 1 |
| Medium | 2 |
| High | 3 |
| Auto | 4 |
| Holidays | 6 |
| Guests | 7 |

Duration encoding:

- Permanently: `manualSettingActiveTill: -1`.
- Until next schedule change: `manualSettingActiveTill: 0` and `controlMode: "schedule"`.
- Specified duration: absolute Unix epoch milliseconds in `manualSettingActiveTill` and `controlMode: "manual"`.

Fireplace is encoded separately with `fireplaceModeStatus` and `fireplaceModeTime` in minutes. Disable behavior must be confirmed by a targeted integration test before the public release; until confirmed, the implementation must not guess the write payload.

## Error handling and notifications

- Network and server errors expose a concise operation name, never raw bodies.
- Authentication errors request credential correction.
- Contract mismatches identify the public product model but redact private identifiers.
- Unconfirmed writes fail and restore the observed capability state.
- Notifications are deduplicated to avoid Timeline spam.
- Recovery transitions may generate the corresponding Homey Flow trigger.

## Testing and release quality

Automated tests will cover:

- nested Vasco payload serialization,
- safe HTTP and logical error handling,
- token expiry and shared reauthentication,
- multi-gateway and multi-device discovery,
- duplicate-pairing prevention,
- minimum device-contract validation,
- capability mapping and absent-property handling,
- all supported standard modes,
- all three duration variants,
- fireplace commands once disable behavior is confirmed,
- write serialization and post-write confirmation,
- polling coalescing, non-overlap, backoff, and recovery,
- pairing handlers,
- Homey device settings,
- Flow action, condition, and trigger behavior,
- suppression of false triggers on initial state,
- manifest validation and Homey CLI checks.

Fixtures must be synthetic and stripped of real email addresses, passwords, tokens, MAC addresses, serial numbers, gateway identifiers, and account responses. Generated or modified code will receive an Aikido scan when that integration is available.

Before public release, the app must be installed locally on the owner's Homey Pro and smoke-tested against the X500. Commands that change physical ventilation state require explicit test steps and post-command verification.

## Public repository

The repository will include:

- an English README,
- Polish app translations,
- developer installation instructions,
- supported-model and community-verification guidance,
- example Flow recipes,
- contribution and issue-reporting guidance,
- a security policy explaining how to report vulnerabilities without posting credentials or captures,
- a license selected before the first public push,
- `.gitignore` rules excluding captures, environment files, credentials, local Homey data, and generated secret-bearing artifacts.

Raw reverse-engineering captures and private API responses must never be committed or attached to public issues.

## Out of scope for the first release

- MQTT push updates.
- Local LAN control without the Vasco cloud.
- Controller mode (`requestedLevel: 5`).
- Support claims for unverified non-X-Series products.
- Schedule editing.
- Firmware updates or gateway administration.

## Acceptance criteria

- A user can pair one or multiple detected X Series units with one driver.
- Credentials are stored only in protected Homey settings and tokens only in memory.
- Account reads are shared and polling is configurable using safe presets.
- The device view accurately presents all supported operational and diagnostic state.
- All six supported standard modes and three duration types work and are verified after writes.
- Fireplace enable and disable are included only after their payloads are integration-tested.
- Flow cards behave as specified without false startup triggers.
- Authentication expiry recovers transparently; credential failures produce one actionable notification.
- Automated tests, Homey validation, local installation, and an X500 smoke test pass.
- The repository contains no private captures or real credentials and is ready for public community development.
