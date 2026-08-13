# Task 7 — Homey capabilities, settings, and translations report

## Status

Complete. The app now uses Homey Compose to define the Vasco/Kermi X Series
driver contract, device settings, bilingual metadata, and the stateless
connection-test maintenance action.

## Commit

- `f5d2232 feat: define Vasco Homey capabilities and settings`

## RED/GREEN evidence

- RED: `node --test test/unit/homey-manifest.test.js` initially failed 3/3
  because the driver and custom-capability Compose files did not exist.
- GREEN: after the initial Compose definitions, the focused manifest suite
  passed 3/3.
- Validation-fix RED: `homey app build` rejected `alarm_filter`; inspection of
  the current Homey system capability catalog confirmed that only
  `alarm_generic` is system-defined. The focused test was extended to require
  custom `alarm_filter`, `alarm_defrost`, and `alarm_rf`, then failed on their
  missing files.
- Validation-fix GREEN: those three custom, read-only alarm capabilities made
  the focused suite pass 3/3; `npm test` passed 50/50; `homey app build`
  completed successfully; and `git diff --check` passed.

## Files

- `.homeycompose/app.json` — Compose source for the SDK v3 app identity.
- `.homeycompose/capabilities/*.json` — custom modes, diagnostics, alarms,
  Fireplace control, and the stateless connection-test button.
- `drivers/vasco-kermi-x/driver.compose.json` — cloud sensor driver,
  system/custom capabilities, and maintenance-action metadata.
- `drivers/vasco-kermi-x/driver.settings.compose.json` — credential, polling,
  duration, and Fireplace settings with English and Polish UI copy.
- `drivers/vasco-kermi-x/README.md` — non-runtime file retained so Homey's
  build bundle preserves the compose-only driver directory.
- `locales/en.json`, `locales/pl.json` — setting-label translations.
- `test/unit/homey-manifest.test.js` and `test/index.js` — manifest contract
  coverage in the full test suite.
- `app.json` — generated manifest from Homey Compose.

## Concerns

- `vasco_test_connection` is intentionally static only: its capability
  listener and validation behavior belong to the later device-runtime task.
- Homey's build process excludes `*.compose.json` from the bundle; the
  driver-local README is therefore required until runtime driver files are
  added in later tasks.
