# Vasco/Kermi Ventilation for Homey

An unofficial, community-maintained Homey app for monitoring and controlling
Vasco and Kermi D, T and X ventilation units through the vendor cloud service.

The initial release is developed and tested on a Vasco X500 (`VMD-17RPS01`).
It is the only physically verified unit; other Vasco and Kermi D, T and X units
require community reports before they are considered supported.

## What it supports

- Low, Medium, High, Auto, Holidays, and Guests operating modes
- Permanent control, control until the next schedule change, and timed overrides
- A Fireplace device toggle that enables the selected duration of 5–85 minutes
- Indoor and outdoor temperatures, supply and exhaust fan readings, bypass and
  controller state, override end time, and available fault indicators
- Multiple ventilation units on one account
- Homey Flow actions, conditions, and device-state triggers

Controller mode is intentionally unsupported because it has not been confirmed
on the tested unit. Turn Fireplace mode off with the device toggle to send the
vendor's zero-minute command.

## Cloud dependency

This integration requires internet access and a working Vasco cloud account.
It does not communicate with the ventilation unit over the local network. Cloud
service availability, authentication changes, or upstream API changes can
temporarily interrupt the app.

The app polls the cloud every 60 seconds by default. You can select a 30, 60,
120, 300, or 600 second interval in the device settings. Units on the same
account share account-level reads. A WebSocket acknowledgement is followed by
polling reconciliation, and repeated failures use backoff instead of overlapping
requests.

## Pairing

1. In Homey, open Devices and choose **Add device**.
2. Select **Vasco/Kermi Ventilation** and enter the credentials for the vendor
   cloud account used by the ventilation unit.
3. Select one or more compatible units from the discovered list.
4. Open each added device and review its polling interval and default override
   durations.

Already-paired units are omitted from discovery. Credentials are stored in
protected Homey device settings and are shared only inside the app runtime for
units using the same account.

## Example Flows

- **When** the filter warning appears, **then** send a maintenance notification.
- **When** the operating mode changes, **then** include the previous and new
  modes in a timeline notification.
- **When** everyone leaves, **and** the mode is not Holidays, **then** set
  Holidays mode until the next schedule change.
- **When** indoor air quality needs a boost, **then** set High mode for 30
  minutes.

## Compatibility and bugs

Use the repository issue forms for compatibility reports and reproducible bugs.
Include the public product model, ventilation-unit software version, Homey
software version, and app version.

Never post credentials, access tokens, account exports, raw cloud responses,
private device identifiers, packet captures, or network captures. For security
issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local
workflow and public-data rules. This project is available under the
[MIT License](LICENSE).

Vasco and Kermi are trademarks of their respective owners. This community
project is not affiliated with or endorsed by the manufacturers or Athom.
