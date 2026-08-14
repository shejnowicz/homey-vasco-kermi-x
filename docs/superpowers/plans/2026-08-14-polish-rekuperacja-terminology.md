# Polish Rekuperacja Terminology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Polish ventilation-unit wording with `rekuperacja` and `rekuperator` consistently across the Homey release while leaving English and runtime behavior unchanged.

**Architecture:** Homey Compose remains the metadata source of truth and generates `app.json`. Contract tests lock the Polish app name, description, driver name, Store copy, changelog, unique tags, and absence of stale terminology in active release files.

**Tech Stack:** Homey Apps SDK v3, Homey Compose, Node.js 22, `node:test`, Homey CLI 4.4.1.

## Global Constraints

- Polish app name is exactly `Rekuperacja Vasco/Kermi`.
- Polish app description is exactly `Komfortowa rekuperacja dopasowana do rytmu domu`.
- Polish driver name is exactly `Rekuperator Vasco/Kermi D / T / X`.
- Polish Store copy uses `rekuperacja`; the `1.0.0` changelog uses `rekuperatory`.
- Keep one Polish `rekuperacja` search tag and remove the redundant `wentylacja` tag.
- English localization and all runtime behavior remain unchanged.
- Edit Compose sources and regenerate `app.json`; never hand-edit generated manifest content.
- Keep version `1.0.0` and update the existing release PR #2; do not create another PR or merge it.

---

### Task 1: Enforce and implement the Polish terminology contract

**Files:**
- Modify: `test/unit/publish-readiness.test.js`
- Modify: `.homeycompose/app.json`
- Modify: `drivers/vasco-kermi-x/driver.compose.json`
- Modify: `README.pl.txt`
- Modify: `.homeychangelog.json`
- Modify: `docs/superpowers/specs/2026-08-13-release-readiness-and-ci-design.md`
- Modify: `docs/superpowers/plans/2026-08-13-release-readiness-and-ci.md`
- Generate: `app.json`

**Interfaces:**
- Consumes: current Homey Compose metadata, Store copy, changelog, and release contracts.
- Produces: a bilingual package whose Polish surface consistently uses rekuperation terminology.

- [ ] **Step 1: Write failing terminology assertions**

Update the Store identity test to require:

```js
assert.deepEqual(app.name, {
  en: 'Vasco/Kermi Ventilation',
  pl: 'Rekuperacja Vasco/Kermi',
});
assert.deepEqual(app.description, {
  en: 'Comfortable ventilation for every Homey routine',
  pl: 'Komfortowa rekuperacja dopasowana do rytmu domu',
});
assert.deepEqual(app.tags.pl, ['jakość powietrza', 'rekuperacja']);
```

Add a test that reads the driver Compose file, `README.pl.txt`, the changelog,
and active release design/plan documents:

```js
test('Polish release surfaces use rekuperacja terminology', () => {
  const driver = readJson('drivers/vasco-kermi-x/driver.compose.json');
  const store = read('README.pl.txt');
  const changelog = readJson('.homeychangelog.json');
  const activeReleaseFiles = [
    store,
    changelog['1.0.0'].pl,
    read('docs/superpowers/specs/2026-08-13-release-readiness-and-ci-design.md'),
    read('docs/superpowers/plans/2026-08-13-release-readiness-and-ci.md'),
  ].join('\n');

  assert.equal(driver.name.pl, 'Rekuperator Vasco/Kermi D / T / X');
  assert.match(store, /Połącz rekuperację Vasco i Kermi/);
  assert.match(changelog['1.0.0'].pl, /dla rekuperatorów Vasco\/Kermi/);
  assert.doesNotMatch(activeReleaseFiles, /wentylacj|central(?:a|e|i|ą) wentylacyjn/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/unit/publish-readiness.test.js
```

Expected: FAIL on the old `Wentylacja Vasco/Kermi`, description, driver name,
Store copy, changelog, tags, and active release documentation.

- [ ] **Step 3: Apply the exact Polish wording**

Make these exact source changes:

- `.homeycompose/app.json`: set the approved Polish name/description and set
  `tags.pl` to `["jakość powietrza", "rekuperacja"]`;
- `drivers/vasco-kermi-x/driver.compose.json`: set `name.pl` to
  `Rekuperator Vasco/Kermi D / T / X`;
- `README.pl.txt`: begin with `Połącz rekuperację Vasco i Kermi serii D, T i X`;
- `.homeychangelog.json`: set Polish text to
  `Pierwsze wydanie społecznościowe dla rekuperatorów Vasco/Kermi serii D, T i X. Przetestowano z Vasco X500.`;
- replace the old prescribed Polish name, description, Store paragraph, and
  driver wording in the active release-readiness design and plan documents.

Do not alter English strings, identifiers, Flow cards, capabilities, or runtime
JavaScript.

- [ ] **Step 4: Regenerate the manifest and verify GREEN**

Run:

```bash
npx homey app build
node --test test/unit/publish-readiness.test.js
npm test
```

Expected: focused tests and complete suite pass; generated `app.json` contains
the exact Polish app/description/driver values and no unrelated manifest change.

- [ ] **Step 5: Run release and safety checks**

Run:

```bash
npm audit --omit=dev --audit-level=high
npx homey app validate --level publish
node --test test/secret-safety.test.js test/unit/publish-assets.test.js
git diff --check
```

Expected: zero high/critical vulnerabilities, publish validation succeeds,
secret/packaging tests pass, and the diff has no whitespace errors. If Aikido
is unavailable, state that explicitly and do not claim an Aikido pass.

- [ ] **Step 6: Commit the terminology update**

```bash
git add .homeycompose/app.json app.json drivers/vasco-kermi-x/driver.compose.json README.pl.txt .homeychangelog.json test/unit/publish-readiness.test.js docs/superpowers/specs/2026-08-13-release-readiness-and-ci-design.md docs/superpowers/plans/2026-08-13-release-readiness-and-ci.md
git commit -m "docs: use Polish rekuperacja terminology"
```

---

### Task 2: Update PR #2 and verify the Test release path

**Files:**
- External update: `release/1.0.0` and GitHub PR #2
- No additional tracked file changes expected

**Interfaces:**
- Consumes: verified terminology commit from Task 1.
- Produces: an updated, green PR #2 ready for owner squash merge; existing Homey Test build remains `1.0.0` until a corrected build is uploaded.

- [ ] **Step 1: Push without force**

```bash
git push origin release/1.0.0
```

Expected: remote branch fast-forwards normally.

- [ ] **Step 2: Wait for required checks**

Use GitHub PR #2 and wait until `test`, `homey-validate`, and
`dependency-audit` all succeed at the new head SHA.

- [ ] **Step 3: Upload the corrected `1.0.0` build**

Because Homey already has Build ID 1 for version `1.0.0`, first inspect the
Developer Tools/CLI response. Upload the corrected package only if Homey accepts
another build of the same Test version; do not bump beyond `1.0.0` without a
separate decision. Publish the accepted build to Test through Developer Tools.

- [ ] **Step 4: Verify final state**

Confirm the Homey Test page displays `Rekuperacja Vasco/Kermi`, PR #2 remains
open and clean with all required checks, and the local worktree is clean. Do not
merge PR #2; the owner performs the squash merge.
