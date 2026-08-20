# Automatic Homey Test Publishing Design

## Goal

Extend the existing Vasco/Kermi GitHub CI so a validated release merged into `main` is automatically uploaded to Homey Developer Tools as a Draft. Documentation-only and other non-release merges must not attempt to republish an existing version.

## CI and release detection

Keep the existing pull-request and `main` validation jobs: automated tests, Homey publish-level validation, and production dependency audit. Update reusable GitHub Actions to current, immutable commit SHAs.

Add a release-detection job for trusted pushes to `main`. It compares the current version in `.homeycompose/app.json` with the version in the push's previous commit and exposes a boolean output. A missing previous version is treated as a release so the workflow remains usable on a new repository. Pull requests and manual workflow runs never receive Homey credentials and never publish.

## Automatic Draft publishing

The publish job runs only when all validation jobs pass, the event is a push to `main`, and release detection confirms that the app version changed. It uses Athom's official `athombv/github-action-homey-app-publish` action pinned to an immutable commit and authenticates with the repository secret `HOMEY_PAT`.

The secret is exposed only to the publish job through the protected `homey-test` GitHub environment. The action uploads a Draft and records its Homey Developer Tools URL in the job summary. The workflow never submits for certification and never publishes to Live. Enabling the uploaded Draft for Test remains an explicit action in Homey Developer Tools.

## Initial automated release

Bump the app from `1.0.4` to `1.0.5` in both Homey Compose source and generated `app.json`. Add localized changelog entries explaining that the release adds automated, validated delivery; application behavior is unchanged. This version change exercises the release-detection and publish path on the first merge.

Future functional releases must update the version and `.homeychangelog.json` in their pull request. Merges without a version change still run all validation jobs but skip publishing successfully.

## Verification and delivery

Verify locally with the complete Node test suite, `homey app build`, an unchanged generated manifest after the build, publish-level Homey validation, and the existing dependency audit threshold. Scan the final diff for credentials and generated build artifacts.

Push the implementation branch, open a pull request, and require all CI jobs to pass while publishing is skipped on the pull request. After merge, verify that the `main` workflow publishes version `1.0.5` as a Draft. Enable it for Test and confirm that the public Homey Test URL responds successfully. Any failure leaves the previous Test release unchanged.

