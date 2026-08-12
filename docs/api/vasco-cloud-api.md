# Vasco/Kermi X Series cloud API notes

This sanitized protocol reference intentionally contains no account data,
credentials, captured traffic, or token values.

## Transport and authentication

- Cloud API base URL: `https://vasco.iqloud.eu/api/`.
- Gateway communication host: `appserver2.iqloud.eu`.
- API requests use HTTP `POST` with JSON.
- Account reads and device writes use the `userToken` protocol field. Account
  configuration also includes a gateway `bridgeToken` field.
- The tested mobile client did not use certificate pinning.

### Login

`POST /api/login` accepts a nested JSON string in `payload`:

```json
{
  "payload": "{\"userInfo\":{\"email\":\"...\",\"password\":\"...\"}}"
}
```

The response protocol contains `payload.userToken`. After login, the mobile
client calls endpoints including `/api/getaccountconfiguration`,
`/api/getbridges`, `/api/accountdetails`, `/api/getagreedterms`, and
`/api/registernewapp`. Application registration accepts `userToken` and returns
the MQTT protocol fields `mqttClientId`, `mqttUserName`, and `mqttPassword`,
leaving REST polling suitable for an MVP and MQTT available for a later
push-update transport.

## Reads

`POST /api/getaccountconfiguration` with `userToken` returns bridges and RF
devices plus current and requested level, inlet and exhaust fan speeds, indoor
and outdoor temperatures, bypass position, filter, fault, defrost, RF
communication, schedule, and next-event information.

Observed device-state fields include `product`, `softwareVersion`, `level`,
`requestedLevel`, `controlMode`, `manualSettingActiveTill`, `fanSpeedInlet`,
`fanSpeedExhaust`, `indoorTemperature`, `outdoorTemperature`, `bypassPosition`,
`filterDirty`, `defrost`, `faultStatus`, `rfCommunicationStatus`, `rssiValue`,
`fireplaceModeStatus`, and `fireplaceModeTime`.

## Writes

Control uses `POST /api/setdeviceproperties`. Its `payload` field is a JSON
string containing an array with the complete device-properties object. Read the
configuration again after a write and confirm the observed state.

## Standard modes

| Mode | `requestedLevel` |
|---|---:|
| Low | 1 |
| Medium | 2 |
| High | 3 |
| Auto | 4 |
| Holidays | 6 |
| Guests | 7 |

`requestedLevel: 5` (Controller) is excluded because activation was not
confirmed for the initial supported model.

### Standard-mode duration

| Behavior | API encoding |
|---|---|
| Permanently | `manualSettingActiveTill: -1` |
| Until next schedule change | `manualSettingActiveTill: 0`, `controlMode: "schedule"` |
| Specified duration | Unix epoch milliseconds in `manualSettingActiveTill`, `controlMode: "manual"` |

## Fireplace mode

Fireplace mode is separate from `requestedLevel`. Enable it with
`fireplaceModeStatus: 1` and a duration in minutes using `fireplaceModeTime`.
The disable payload and post-expiry behavior require an explicit integration
test before implementation.

## Implementation guidance

Use REST polling first, preserve unknown device properties during writes, and
verify every requested state change with a fresh read. Keep credentials and
protocol-token values out of source code, fixtures, logs, diagnostics, and
version control.
