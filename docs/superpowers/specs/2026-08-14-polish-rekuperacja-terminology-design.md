# Polish Rekuperacja Terminology Design

## Goal

Use terminology natural to Polish users throughout the Homey app: `rekuperacja`
for the system or process and `rekuperator` for the physical device. English
copy remains unchanged.

## User-facing terminology

- Polish app name: `Rekuperacja Vasco/Kermi`.
- Polish app description: `Komfortowa rekuperacja dopasowana do rytmu domu`.
- Polish driver name: `Rekuperator Vasco/Kermi D / T / X`.
- Store copy uses `rekuperacja` instead of `wentylacja`.
- The `1.0.0` Polish changelog uses `rekuperatory` instead of
  `centrale wentylacyjne`.
- The duplicate Polish search tag is removed: keep the existing
  `rekuperacja` tag and remove `wentylacja`.

## Repository consistency

Update the release-readiness contract tests and project design/plan documents
that prescribe the old Polish wording. Regenerate `app.json` through Homey
Compose; do not edit it directly. No runtime behavior, capabilities, Flow card
identifiers, cloud protocol logic, or English localization changes.

## Verification

- A regression test asserts the new Polish app and driver names.
- A repository scan finds no Polish `wentylacja`, `wentylacyjna`, or
  `centrale wentylacyjne` wording in release-facing files or active project
  contracts.
- The complete test suite, Homey build, generated-manifest cleanliness, and
  publish validation pass.
- Secret-safety and dependency-audit checks remain clean.
