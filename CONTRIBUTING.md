# Contributing

Thank you for helping improve this community Homey integration.

## Before opening an issue

Use the compatibility form for a new ventilation-unit model and the bug form
for reproducible application behaviour. Search existing issues first. Public
reports may include product model names and software versions, but must never
contain credentials, access tokens, account exports, raw cloud responses,
private device identifiers, packet captures, or network captures.

Report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Development workflow

1. Fork the repository and create a focused branch.
2. Install the pinned dependencies with `npm ci`.
3. Add or update automated tests for behavioural changes.
4. Run `npm test` (the `test` check).
5. Run `npm audit --omit=dev --audit-level=high` (the `dependency-audit` check).
6. Run `homey app build`, confirm `git diff --exit-code -- app.json`, and run
   `homey app validate --level publish` (the `homey-validate` check).
7. Open a pull request describing the user-visible change and verification.

The app uses Homey Apps SDK v3 and Homey Compose. Edit `.homeycompose/app.json`
and the driver Compose files; do not hand-edit generated `app.json` content.
Keep protocol handling in `lib/`, avoid logging private values, and use only
synthetic fixtures committed specifically for tests.

## Compatibility contributions

Compatibility work must start from public product information and sanitized
behavioural observations. Do not upload vendor-account traffic or ask another
contributor to collect it. A model is considered verified only after its minimum
property contract, state mapping, and safe command behaviour have been tested.

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository.
