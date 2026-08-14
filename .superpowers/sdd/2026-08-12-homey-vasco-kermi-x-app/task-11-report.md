# Task 11 report — community release preparation

## Status

DONE_WITH_CONCERNS

## Scope delivered

- Replaced the placeholder project README with community-facing compatibility,
  cloud-dependency, pairing, capability, polling, Flow, privacy, contribution,
  and trademark guidance.
- Added concise plain-text English and Polish Homey Store descriptions.
- Added contributor guidance, consistent private security-reporting guidance,
  safe bug and compatibility issue forms, and a read-only validation workflow.
- Confirmed the existing license is MIT with the correct 2026 copyright notice.
- Added `.homeyignore` packaging rules for repository-only material and editable
  illustration sources while retaining store descriptions and rendered assets.
- Added Homey Compose brand color, app/driver images, search tags, source,
  homepage, support, and bug-tracker metadata.
- Replaced the inherited rocket artwork with neutral, trademark-free ventilation
  unit SVG icons and deterministic code-native SVG store scenes.

No App Store publish, version bump, release, or external write was performed.

## Public-release checklist review

The community README was manually checked for every Task 11 requirement:

- Vasco X500 (`VMD-17RPS01`) tested-model disclosure: present.
- Other X Series models require community verification: present.
- Internet and vendor-cloud dependency: present.
- Pairing steps: present.
- Low, Medium, High, Auto, Holidays, and Guests modes: all present.
- Default and selectable polling intervals, shared reads, immediate command
  verification, and retry behaviour: present.
- Example Homey Flows: present.
- Warning against credentials, tokens, account exports, raw responses, private
  identifiers, and network/packet captures: present.

Both issue forms request the public product model, ventilation-unit software
version, Homey software version, and app version. Their input and textarea
fields do not request captures, raw account responses, credentials, or secrets.

## TDD evidence

RED: `node --test test/unit/publish-assets.test.js` failed 3/3 because publish
metadata, store descriptions, ignore rules, issue forms, driver icon, and store
images did not exist.

GREEN: the focused suite passes 3/3. It checks app and driver image references,
SVG icon existence, PNG signatures and exact dimensions, source/support/brand
metadata, plain-text Store constraints, packaging exclusions, and safe issue
form request fields.

## Asset verification

All six rendered PNGs were opened and visually inspected at their actual pixel
dimensions. The ventilation unit, airflow, contrast, and status details remain
legible at the smallest sizes.

- App: 250×175, 500×350, and 1000×700 PNG.
- Driver: 75×75, 500×500, and 1000×1000 PNG.
- App and driver icon: monochrome ventilation-unit SVG, with no wordmark or
  manufacturer logo.

The installed publishing skill reference said driver images use the app's 10:7
sizes. Homey CLI 4.4.1 publish validation rejected that assumption. Its installed
`homey-lib` declares driver sizes of 75×75, 500×500, and 1000×1000, while the
manifest schema permits `xlarge`. The tests and assets follow the current CLI;
publish validation then passed.

## CI and verification

`.github/workflows/validate.yml` performs `npm ci`, `npm test`,
`homey app build`, and `homey app validate --level publish` on pull requests and
pushes to `main`. It has read-only repository permissions and does not publish.

Fresh local verification:

- `npm ci`: passed; 0 dependency vulnerabilities.
- `npm test`: passed; 91 tests, 0 failures.
- `homey app build`: passed.
- `homey app validate --level publish`: passed with no warnings.
- Publish-package assertions: rendered assets and Store descriptions included;
  editable SVG scene sources excluded.
- `git diff --check`: passed.

## Security review

Public docs and forms consistently prohibit private diagnostic material. CI has
read-only repository permissions and contains no publishing credential or
publish job. The Aikido scan skill was invoked, but its required MCP scanner was
not available in this session, so an Aikido scan could not be run.

## Concerns

The only remaining verification gap is the unavailable Aikido MCP scan. Homey
publish validation, the complete automated suite, package audit, and dependency
audit are clean.

## Fix round 1

Addressed all three release-review findings:

- Removed the personal Gmail fallback from `SECURITY.md`; GitHub private
  vulnerability reporting is now the only named channel, and a repository scan
  finds no remaining Gmail address.
- Pinned CI to the locally verified Homey CLI version, `homey@4.4.1`.
- Rewrote both Store descriptions as concise neutral prose without a feature
  list, URL, Markdown, or changelog content.

The publish contract now asserts that SECURITY contains no email address, the
CI command uses the exact Homey CLI pin and not an unversioned install, and both
Store descriptions remain short prose rather than comma-heavy feature lists.

RED: focused publish tests failed on the previous Store copy and public release
channel policy. GREEN: 4 focused tests passed. Fresh full verification passed
with 92 tests, Homey build, publish-level validation, and `git diff --check`.
The Aikido MCP scanner remained unavailable.
