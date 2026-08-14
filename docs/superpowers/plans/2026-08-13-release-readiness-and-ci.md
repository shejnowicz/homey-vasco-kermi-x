# Release Readiness and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare accurate Homey Store metadata, enforce three independent CI checks, open the initial application pull request, and protect `main` without merging it.

**Architecture:** Keep product metadata in Homey Compose and Store copy files, and enforce their public-release contract with Node's built-in test runner. GitHub Actions exposes independent test, Homey validation, and dependency-audit jobs; GitHub branch protection then requires those exact job names before owner-controlled merges.

**Tech Stack:** Homey Apps SDK v3, Homey Compose, Node.js 22, `node:test`, Homey CLI 4.4.1, GitHub Actions, GitHub CLI/REST API.

## Global Constraints

- The repository's protected integration branch is `main`; do not create `master`.
- English app name is `Vasco/Kermi Ventilation`; Polish app name is `Wentylacja Vasco/Kermi`.
- The integration is community-maintained, uses the vendor cloud, and is physically verified only with Vasco X500.
- Other Vasco and Kermi D/T/X models require community verification; do not claim blanket compatibility.
- Do not claim a local Fireplace countdown, previous-mode restoration, or an unsupported Stop mechanism.
- CI uses Node.js 22 and globally installs exactly Homey CLI `4.4.1`.
- CI must not publish the app or store a Homey token.
- Required checks are exactly `test`, `homey-validate`, and `dependency-audit`.
- Pull requests and up-to-date checks apply to administrators; zero approving reviews are required.
- Review conversations must be resolved; force pushes and deletion of `main` remain disabled.
- Push and open the pull request, but do not merge it.
- Leave version `0.1.0` in this pull request; prepare `1.0.0` only with a separately authorized Test-channel publication.

---

### Task 1: Lock the Store identity and copy contract

**Files:**
- Modify: `test/unit/publish-readiness.test.js`
- Modify: `test/unit/publish-assets.test.js`
- Modify: `.homeycompose/app.json`
- Modify: `README.txt`
- Modify: `README.pl.txt`

**Interfaces:**
- Consumes: Homey Compose metadata from `.homeycompose/app.json` and plain-text Store descriptions from `README.txt` and `README.pl.txt`.
- Produces: bilingual app identity and Store copy verified by `node:test`; generated `app.json` remains an output of `homey app build`, not a hand-edited source.

- [ ] **Step 1: Replace stale Fireplace-copy tests with the release identity contract**

Replace `test/unit/publish-readiness.test.js` with:

```js
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', '..');

function read(filename) {
  return readFileSync(join(root, filename), 'utf8');
}

function readJson(filename) {
  return JSON.parse(read(filename));
}

test('Homey Store identity uses the D/T/X community product name', () => {
  const app = readJson('.homeycompose/app.json');

  assert.deepEqual(app.name, {
    en: 'Vasco/Kermi Ventilation',
    pl: 'Wentylacja Vasco/Kermi',
  });
  assert.deepEqual(app.description, {
    en: 'Comfortable ventilation for every Homey routine',
    pl: 'Komfortowa wentylacja dopasowana do rytmu domu',
  });
  assert.equal(app.version, '0.1.0');
});

for (const [filename, languagePattern] of [
  ['README.txt', /developed and tested with Vasco X500/i],
  ['README.pl.txt', /opracowano i przetestowano z Vasco X500/i],
]) {
  test(`${filename} states the verified model and community scope`, () => {
    const description = read(filename);

    assert.match(description, /D, T (?:and|i) X/i);
    assert.match(description, languagePattern);
    assert.match(description, /community verification|weryfikacji społeczności/i);
    assert.doesNotMatch(
      description,
      /remaining time|pozostały czas|restores? the prior|przywraca poprzedni|local session|lokaln.*sesj/i,
    );
  });
}
```

Extend the existing `store descriptions are plain text...` test in
`test/unit/publish-assets.test.js` with these assertions inside its filename
loop:

```js
assert.doesNotMatch(description, /\b(?:adds support|integrates|control devices)\b/i);
assert.doesNotMatch(description, /\b(?:dodaje obsługę|integruje|steruj urządzeniami)\b/i);
```

- [ ] **Step 2: Run the focused tests and verify the old metadata fails**

Run:

```bash
node --test test/unit/publish-readiness.test.js test/unit/publish-assets.test.js
```

Expected: FAIL because the Compose app name, descriptions, and Store copy still describe X Series and stale Fireplace session behavior.

- [ ] **Step 3: Apply the approved bilingual metadata and concise Store copy**

In `.homeycompose/app.json`, keep all unrelated fields unchanged and set:

```json
"name": {
  "en": "Vasco/Kermi Ventilation",
  "pl": "Wentylacja Vasco/Kermi"
},
"description": {
  "en": "Comfortable ventilation for every Homey routine",
  "pl": "Komfortowa wentylacja dopasowana do rytmu domu"
}
```

Set `README.txt` to this single paragraph:

```text
Bring Vasco and Kermi D, T and X ventilation into daily Homey routines through the vendor cloud. View readings and system status, choose operating modes and build Flows for schedules or temporary overrides. Developed and tested with Vasco X500; other models need community verification.
```

Set `README.pl.txt` to this single paragraph:

```text
Połącz wentylację Vasco i Kermi serii D, T i X z rytmem domu przez chmurę producenta. Sprawdzaj odczyty i stan systemu, wybieraj tryby pracy oraz twórz Flow dla harmonogramów i czasowych zmian. Opracowano i przetestowano z Vasco X500; inne modele wymagają weryfikacji społeczności.
```

- [ ] **Step 4: Run the focused tests and verify the release contract passes**

Run:

```bash
node --test test/unit/publish-readiness.test.js test/unit/publish-assets.test.js
```

Expected: all focused tests PASS, including the existing 300-character, plain-text, URL, comma-count, icon, and packaging checks.

- [ ] **Step 5: Build Compose output and confirm only generated manifest changes**

Run:

```bash
npx homey app build
git diff --check
git diff -- .homeycompose/app.json app.json README.txt README.pl.txt test/unit/publish-readiness.test.js test/unit/publish-assets.test.js
```

Expected: `app.json` contains the new generated names/descriptions, no whitespace errors appear, and no unrelated generated manifest fields change.

- [ ] **Step 6: Commit the Store identity contract**

```bash
git add .homeycompose/app.json app.json README.txt README.pl.txt test/unit/publish-readiness.test.js test/unit/publish-assets.test.js
git commit -m "docs: prepare Homey Store identity"
```

---

### Task 2: Align public documentation with current behavior and D/T/X scope

**Files:**
- Modify: `test/unit/publish-readiness.test.js`
- Modify: `README.md`
- Modify: `.github/ISSUE_TEMPLATE/compatibility.yml`
- Modify: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: the implemented device behavior and public product scope established in Task 1.
- Produces: accurate public documentation and a sanitized D/T/X compatibility-report path for contributors.

- [ ] **Step 1: Add a failing public-documentation regression test**

Append to `test/unit/publish-readiness.test.js`:

```js
test('public documentation describes D/T/X scope and current Fireplace control', () => {
  const readme = read('README.md');
  const compatibility = read('.github/ISSUE_TEMPLATE/compatibility.yml');
  const contributing = read('CONTRIBUTING.md');

  assert.match(readme, /^# Vasco\/Kermi Ventilation for Homey$/m);
  assert.match(readme, /D, T and X/i);
  assert.match(readme, /Fireplace.*toggle.*selected duration/i);
  assert.match(readme, /turn.*Fireplace.*off/i);
  assert.doesNotMatch(readme, /explicit disabling is not offered/i);
  assert.doesNotMatch(readme, /exact remaining time|restores? the prior/i);
  assert.match(compatibility, /D, T (?:and|or) X/i);
  assert.match(contributing, /test|homey-validate|dependency-audit/i);
});
```

- [ ] **Step 2: Run the focused test and verify stale documentation fails**

Run:

```bash
node --test test/unit/publish-readiness.test.js
```

Expected: FAIL because `README.md` and the compatibility form still say X Series, README still says disabling is unavailable, and contribution guidance does not identify the CI checks.

- [ ] **Step 3: Rewrite the affected README sections without expanding product claims**

Make these exact semantic changes in `README.md`:

- use heading `# Vasco/Kermi Ventilation for Homey`;
- describe Vasco and Kermi D, T and X ventilation units through the vendor cloud;
- state that Vasco X500 (`VMD-17RPS01`) is the only physically verified unit and other models require reports;
- describe the Fireplace device toggle as enabling for the selected 5–85 minute duration and sending the vendor's zero-minute command when switched off;
- keep Controller mode explicitly unsupported;
- retain cloud dependency, polling, privacy, license, and trademark disclaimers;
- change pairing selection text to `Vasco/Kermi Ventilation`;
- remove every claim about exact remaining time, Homey-owned sessions, restoring a previous mode, or inability to disable Fireplace mode.

In `.github/ISSUE_TEMPLATE/compatibility.yml`, set:

```yaml
description: Share sanitized results for a Vasco or Kermi D, T or X ventilation-unit model.
```

In `CONTRIBUTING.md`, replace the validation portion of the development workflow with:

```markdown
4. Run `npm test` (the `test` check).
5. Run `npm audit --omit=dev --audit-level=high` (the `dependency-audit` check).
6. Run `homey app build`, confirm `git diff --exit-code -- app.json`, and run
   `homey app validate --level publish` (the `homey-validate` check).
7. Open a pull request describing the user-visible change and verification.
```

- [ ] **Step 4: Run the documentation and privacy tests**

Run:

```bash
node --test test/unit/publish-readiness.test.js test/unit/publish-assets.test.js test/secret-safety.test.js
```

Expected: all focused tests PASS; issue forms still do not request captures, raw responses, credentials, or tokens.

- [ ] **Step 5: Scan for stale public claims**

Run:

```bash
rg -n "X Series|remaining time|pozostały czas|restores? the prior|przywraca poprzedni|explicit disabling is not offered|Homey-owned session" README.md README.txt README.pl.txt .github/ISSUE_TEMPLATE CONTRIBUTING.md
```

Expected: no stale claim is returned. An X500 model reference is allowed because it identifies the verified unit, but the phrase `X Series` is absent.

- [ ] **Step 6: Commit the public documentation update**

```bash
git add README.md .github/ISSUE_TEMPLATE/compatibility.yml CONTRIBUTING.md test/unit/publish-readiness.test.js
git commit -m "docs: align public release guidance"
```

---

### Task 3: Split GitHub Actions into required checks

**Files:**
- Modify: `test/unit/publish-readiness.test.js`
- Modify: `.github/workflows/validate.yml`

**Interfaces:**
- Consumes: package scripts `npm test`, `npm audit`, Homey CLI build, and Homey publish validation.
- Produces: stable GitHub check contexts named `test`, `homey-validate`, and `dependency-audit` for branch protection.

- [ ] **Step 1: Add a failing workflow contract test**

Append to `test/unit/publish-readiness.test.js`:

```js
test('CI exposes the three protected checks without publishing', () => {
  const workflow = read('.github/workflows/validate.yml');

  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s{2}test:\s*$/m);
  assert.match(workflow, /^\s{2}homey-validate:\s*$/m);
  assert.match(workflow, /^\s{2}dependency-audit:\s*$/m);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /npm install --global homey@4\.4\.1/);
  assert.match(workflow, /git diff --exit-code -- app\.json/);
  assert.match(workflow, /homey app validate --level publish/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.doesNotMatch(workflow, /homey app publish|HOMEY_TOKEN|ATHOM_TOKEN/i);
});
```

- [ ] **Step 2: Run the workflow contract test and verify the monolithic job fails**

Run:

```bash
node --test test/unit/publish-readiness.test.js
```

Expected: FAIL because the current workflow has one `validate` job, no manual dispatch, no dependency audit, and no generated-manifest cleanliness check.

- [ ] **Step 3: Replace the workflow with the approved independent jobs**

Set `.github/workflows/validate.yml` to:

```yaml
name: Validate Homey app

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: validate-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install project dependencies
        run: npm ci
      - name: Run tests
        run: npm test

  homey-validate:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install project dependencies
        run: npm ci
      - name: Install Homey CLI
        run: npm install --global homey@4.4.1
      - name: Build app
        run: homey app build
      - name: Verify generated manifest
        run: git diff --exit-code -- app.json
      - name: Validate publish package
        run: homey app validate --level publish

  dependency-audit:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install project dependencies
        run: npm ci
      - name: Audit production dependencies
        run: npm audit --omit=dev --audit-level=high
```

- [ ] **Step 4: Run the workflow contract and the complete unit suite**

Run:

```bash
node --test test/unit/publish-readiness.test.js test/unit/publish-assets.test.js
npm test
```

Expected: focused tests PASS and the complete suite reports zero failures.

- [ ] **Step 5: Inspect the workflow diff and syntax-sensitive expressions**

Run:

```bash
git diff --check
git diff -- .github/workflows/validate.yml test/unit/publish-readiness.test.js
rg -n "^  (test|homey-validate|dependency-audit):|homey app publish|TOKEN" .github/workflows/validate.yml
```

Expected: exactly the three job keys appear; no publish command or token variable appears.

- [ ] **Step 6: Commit the CI split**

```bash
git add .github/workflows/validate.yml test/unit/publish-readiness.test.js
git commit -m "ci: add protected release checks"
```

---

### Task 4: Run the complete local release gate

**Files:**
- Verify: entire tracked application tree
- Generated and verify: `app.json`

**Interfaces:**
- Consumes: all deliverables from Tasks 1–3.
- Produces: evidence that the exact commit intended for the pull request passes tests, dependency review, Homey Compose generation, publish validation, secret-safety checks, and repository hygiene checks.

- [ ] **Step 1: Install the locked dependencies from a clean package state**

Run:

```bash
npm ci
```

Expected: exit code 0 with no lockfile modification.

- [ ] **Step 2: Run all automated tests**

Run:

```bash
npm test
```

Expected: every test passes with zero skipped release-contract tests and zero failures.

- [ ] **Step 3: Audit production dependencies**

Run:

```bash
npm audit --omit=dev --audit-level=high
```

Expected: exit code 0 and zero high or critical vulnerabilities.

- [ ] **Step 4: Build and prove the generated manifest is committed**

Run:

```bash
npx homey app build
git diff --exit-code -- app.json
```

Expected: build succeeds and the diff command exits 0.

- [ ] **Step 5: Run Homey debug and publish validation**

Run:

```bash
npx homey app validate --level debug
npx homey app validate --level publish
```

Expected: both validation levels succeed without errors.

- [ ] **Step 6: Run security and repository hygiene checks**

Run:

```bash
node --test test/secret-safety.test.js test/unit/publish-assets.test.js
git diff --check
git status --short
```

Expected: security/packaging tests pass, whitespace check is clean, and `git status --short` prints nothing. If the Aikido scan service is unavailable, record that fact in the PR verification section and rely on these repository-local secret and dependency checks rather than claiming an Aikido result.

---

### Task 5: Push the feature branch and open the owner-reviewed pull request

**Files:**
- External create: GitHub pull request from `feature/initial-app` to `main`
- No repository file modifications expected

**Interfaces:**
- Consumes: the clean, verified `feature/initial-app` branch from Task 4.
- Produces: a public pull request targeting `main`; it does not merge or publish the Homey app.

- [ ] **Step 1: Confirm repository identity, branch, and authentication**

Run:

```bash
git branch --show-current
git remote -v
gh auth status
gh repo view shejnowicz/homey-vasco-kermi-x --json defaultBranchRef,nameWithOwner
```

Expected: current branch is `feature/initial-app`, remote repository is `shejnowicz/homey-vasco-kermi-x`, authentication belongs to the owner, and the default branch is `main`.

- [ ] **Step 2: Push the verified feature branch without force**

Run:

```bash
git push --set-upstream origin feature/initial-app
```

Expected: the remote branch is created or fast-forwarded; no force option is used.

- [ ] **Step 3: Open the pull request against `main`**

Run:

```bash
gh pr create \
  --repo shejnowicz/homey-vasco-kermi-x \
  --base main \
  --head feature/initial-app \
  --title "feat: add Vasco/Kermi ventilation app" \
  --body "$(printf '%s\n' \
    '## Summary' \
    '- add the community Vasco/Kermi D, T and X Homey integration' \
    '- add pairing, controls, diagnostics, Flow cards, Fireplace mode, documentation, and Store assets' \
    '- add independent test, Homey validation, and dependency audit checks' \
    '' \
    '## Verification' \
    '- npm test' \
    '- npm audit --omit=dev --audit-level=high' \
    '- homey app validate --level debug' \
    '- homey app validate --level publish' \
    '- secret-safety and packaging tests' \
    '- Aikido service unavailable; no Aikido result is claimed' \
    '' \
    '## Release' \
    '- do not merge automatically; owner review is required' \
    '- Homey Store Test publication and the 1.0.0 version bump are separate follow-up actions')"
```

Expected: GitHub returns the URL of one open PR whose base is `main` and head is `feature/initial-app`.

- [ ] **Step 4: Verify the PR metadata without merging**

Run:

```bash
gh pr view --repo shejnowicz/homey-vasco-kermi-x --json number,url,state,baseRefName,headRefName,mergeStateStatus
```

Expected: state is `OPEN`, base is `main`, head is `feature/initial-app`; do not run `gh pr merge`.

---

### Task 6: Protect `main` with the successful PR checks

**Files:**
- External modify: GitHub branch protection for `main`
- No repository file modifications expected

**Interfaces:**
- Consumes: successful GitHub check runs named `test`, `homey-validate`, and `dependency-audit` from Task 5.
- Produces: administrator-enforced branch protection with strict checks and owner-controlled merging.

- [ ] **Step 1: Wait for and inspect all pull-request checks**

Run:

```bash
gh pr checks --repo shejnowicz/homey-vasco-kermi-x --watch --interval 10
```

Expected: `test`, `homey-validate`, and `dependency-audit` all finish successfully. Stop and diagnose any failed check before modifying protection.

- [ ] **Step 2: Reconfirm that no additional writer can merge**

Run:

```bash
gh api repos/shejnowicz/homey-vasco-kermi-x/collaborators --jq '.[] | {login, permissions}'
```

Expected: only `shejnowicz` has push or admin permission. If another writer is listed, do not claim owner-only merging and stop before protection changes.

- [ ] **Step 3: Apply strict branch protection**

Run:

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  repos/shejnowicz/homey-vasco-kermi-x/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test", "homey-validate", "dependency-audit"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON
```

Expected: GitHub returns protection details with administrator enforcement enabled and the three required contexts.

- [ ] **Step 4: Read back and verify the effective policy**

Run:

```bash
gh api repos/shejnowicz/homey-vasco-kermi-x/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, contexts: [.required_status_checks.contexts[].context], enforce_admins: .enforce_admins.enabled, approvals: .required_pull_request_reviews.required_approving_review_count, conversations: .required_conversation_resolution.enabled, force_pushes: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
```

Expected:

```json
{
  "strict": true,
  "contexts": ["test", "homey-validate", "dependency-audit"],
  "enforce_admins": true,
  "approvals": 0,
  "conversations": true,
  "force_pushes": false,
  "deletions": false
}
```

- [ ] **Step 5: Confirm the PR remains open for the owner's merge**

Run:

```bash
gh pr view --repo shejnowicz/homey-vasco-kermi-x --json url,state,mergeStateStatus,statusCheckRollup
git status --short
```

Expected: the PR is still `OPEN`, required checks are successful, and the local worktree is clean. Hand the PR URL to the owner; do not merge and do not publish to the Homey Store.

---

### Follow-up after owner merge: Homey Test channel

This is deliberately outside the current implementation authorization. In a
separate change, bump the app to `1.0.0`, publish interactively to the Homey
App Store Test channel, install or upgrade from that channel, and repeat pairing,
credential-error, control, Flow, Fireplace, and external-state synchronization
tests. Submit for certification only after Test-channel feedback is resolved.
