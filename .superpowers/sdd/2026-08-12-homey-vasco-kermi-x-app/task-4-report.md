# Task 4 — Vasco operating-mode command construction report

## Status

Complete. Mode and fireplace-enable command builders clone complete device
objects, change only documented control fields, and use the mapper's public
state keys for confirmation checks.

## Commit

- `e42af11 feat: build verified Vasco mode commands`
- `d6449e7 fix: harden Vasco mode validation`

## RED/GREEN evidence

- RED: `node --test test/unit/vasco-command-builder.test.js` exited with the
  expected `Cannot find module '../../lib/vasco-modes'` error before
  implementation.
- GREEN: the focused command passed all 6 command-builder tests after the
  minimal implementation.
- Full verification: `npm test` passed 19 tests with 0 failures, and
  `git diff --check` reported no whitespace errors.

## Files

- `lib/vasco-modes.js` — the supported operating-mode mapping, excluding
  controller level 5.
- `lib/vasco-command-builder.js` — immutable command construction, duration
  validation, and observed-state confirmation helpers.
- `test/unit/vasco-command-builder.test.js` — literal request-encoding,
  preservation, validation, and confirmation tests.
- `test/index.js` — includes the command-builder unit suite in `npm test`.

## Self-review

- Every builder uses `structuredClone(raw)` and tests prove the input and its
  nested unknown fields remain unmodified.
- Mode commands preserve all unknown properties while changing only the
  requested level plus duration-specific control fields.
- Timed commands compute the absolute expiry as the supplied `nowMs` plus
  literal minute-to-millisecond conversion; only whole minutes 1–1440 are
  accepted.
- Fireplace support is intentionally enable-only. No speculative disable
  payload is exported or emitted.
- Test fixtures contain only synthetic identifiers and make no network calls.

## Concerns

No blocking concerns. A future integration test should confirm the actual
cloud response after a fireplace-enable request. Fireplace disable remains
intentionally unimplemented until its protocol payload is verified.

## Fix round 1/5 — RED/GREEN evidence

- RED: the inherited-name test failed because `toString` was accepted without
  throwing. GREEN: after own-property validation, the focused suite passed
  7/7 tests.
- RED: the immutable-mapping test found an inherited object prototype where a
  null prototype was required. GREEN: the frozen null-prototype mapping passed
  the focused suite at 8/8 tests and rejected an attempted controller level-5
  extension.
- RED: a timed request for 0 minutes incorrectly returned confirmed. GREEN:
  shared 1–1440 minute validation made 0, fractional, and 1441-minute
  requests return false; the focused suite passed 9/9 tests.
- Final verification for this fix round: `npm test` passed 22 tests with 0
  failures, and `git diff --check` passed.
