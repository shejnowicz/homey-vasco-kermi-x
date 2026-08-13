# Task 10 report — Homey Flow cards

## Status

DONE_WITH_CONCERNS

## Scope delivered

- Added all approved Flow actions except `disable_fireplace`, which remains
  intentionally absent until its cloud payload is verified.
- Added the six approved conditions and all eight triggers, including the
  externally-observable `fireplace_disabled` transition.
- Added bilingual short titles and `titleFormatted` text, six supported mode
  values, bounded 1–1440 minute arguments, and invertible boolean conditions.
- Registered action, condition, and device-trigger listeners once in `app.js`.
  The Task 9 transition hook now delivers only recognized device transitions.

## TDD evidence

RED: `node --test test/unit/flow-cards.test.js` initially failed because the
Flow manifests and listener registrations did not exist.

GREEN: `node --test test/unit/flow-cards.test.js` passed: 2 tests, 0 failures.
The focused test covers manifest IDs, translations, device arguments, modes,
minute bounds, tokens, omitted Fireplace disable action, listener delegation,
conditions, transition delivery, and invalid-duration rejection.

## Verification

- `npm test`: passed, 88 tests and 0 failures.
- `homey app build`: passed with no Flow warnings.
- `homey app validate --level publish`: Flow manifests preprocessed cleanly;
  it stopped only because Task 11 has not added required driver store images.
- `git diff --check`: passed.

## Security review

Action errors are fixed and redacted; no credentials, protocol tokens, or raw
responses are handled by the Flow listeners. The Aikido MCP scanner was not
available in this session, so an Aikido scan could not be run.

## Concerns

Publish-level validation remains blocked by the pre-existing Task 11 store
asset requirement: `drivers.vasco-kermi-x: property images is required in
order to publish an app`.
