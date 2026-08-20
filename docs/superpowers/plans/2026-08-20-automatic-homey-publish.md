# Automatic Homey Test Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically upload validated, versioned Vasco/Kermi releases merged into `main` to Homey Developer Tools as Drafts while safely skipping non-release merges.

**Architecture:** Extend the existing validation workflow with a trusted `main`-only release detector and an Athom publish job gated on a changed Homey app version. Release metadata remains reviewable in the pull request, and `HOMEY_PAT` is available only to the protected publish job.

**Tech Stack:** GitHub Actions, Node.js 22, Node test runner, Homey CLI 4.4.1, Homey Apps SDK v3, Athom Homey App Publish Action.

**Spec:** `docs/superpowers/specs/2026-08-20-automatic-homey-publish-design.md`

## Global Constraints

- Publish only on a trusted push to `main` whose `.homeycompose/app.json` version differs from the previous commit.
- Pull requests and manual dispatches must never receive `HOMEY_PAT` and must never publish.
- Upload a Draft only; never submit for certification or publish to Live.
- Use Node.js 22 and Homey CLI 4.4.1.
- Pin all reusable GitHub Actions to immutable commit SHAs.
- Preserve the existing high-severity production dependency audit gate.
- The workflow must not create commits or recursively trigger itself.

---

### Task 1: Prepare release 1.0.5

**Files:**
- Modify: `.homeycompose/app.json`
- Modify: `app.json`
- Modify: `.homeychangelog.json`
- Modify: `test/unit/publish-readiness.test.js`

**Interfaces:**
- Consumes: current release version `1.0.4` and existing version/changelog tests.
- Produces: reviewable Homey release `1.0.5` with bilingual changelog metadata.

- [ ] **Step 1: Write failing release assertions**

Change the manifest assertion to `1.0.5` and add:

```js
test('automatic publishing release has bilingual changelog copy', () => {
  const changelog = readJson('.homeychangelog.json');

  assert.match(changelog['1.0.5'].en, /automated.*validated/i);
  assert.match(changelog['1.0.5'].pl, /automatycz.*walidowan/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/unit/publish-readiness.test.js
```

Expected: FAIL because the manifest still contains `1.0.4` and changelog entry `1.0.5` is absent.

- [ ] **Step 3: Add release metadata**

Set `version` to `1.0.5` in `.homeycompose/app.json` and regenerate `app.json` with `homey app build`. Prepend this entry to `.homeychangelog.json`:

```json
"1.0.5": {
  "en": "Added automated, validated delivery of versioned releases to Homey Developer Tools.",
  "pl": "Dodano automatyczne, walidowane dostarczanie wersjonowanych wydań do Homey Developer Tools."
}
```

- [ ] **Step 4: Verify GREEN and generated-manifest consistency**

Run:

```bash
node --test test/unit/publish-readiness.test.js
homey app build
git diff --exit-code -- app.json
```

Expected: focused tests pass and the second build does not change `app.json`.

- [ ] **Step 5: Commit release metadata**

```bash
git add .homeycompose/app.json app.json .homeychangelog.json test/unit/publish-readiness.test.js
git commit -m "chore: prepare automated release 1.0.5"
```

### Task 2: Version-gated automatic publishing workflow

**Files:**
- Modify: `.github/workflows/validate.yml`
- Modify: `test/unit/publish-readiness.test.js`

**Interfaces:**
- Consumes: GitHub push metadata `github.event.before`, the current `.homeycompose/app.json` version, successful validation jobs, and `secrets.HOMEY_PAT`.
- Produces: `release.outputs.changed` as string `true` or `false`, and a Homey Draft management URL when publishing runs.

- [ ] **Step 1: Replace the old non-publishing contract with failing CI/CD assertions**

Rename the existing CI test to `CI validates changes and publishes only versioned main releases`. Retain its validation assertions and replace the no-publish assertion with:

```js
assert.match(workflow, /actions\/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09/);
assert.match(workflow, /actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/);
assert.match(workflow, /^\s{2}release:\s*$/m);
assert.match(workflow, /github\.event_name == 'push'.*refs\/heads\/main/);
assert.match(workflow, /git show .*\.homeycompose\/app\.json/);
assert.match(workflow, /^\s{2}publish:\s*$/m);
assert.match(workflow, /needs\.release\.outputs\.changed == 'true'/);
assert.match(workflow, /needs: \[test, homey-validate, dependency-audit, release\]/);
assert.match(workflow, /environment:\s*homey-test/);
assert.match(workflow, /athombv\/github-action-homey-app-publish@0642b483f1eb66fbceb0c91b73df35d45fd2f3db/);
assert.match(workflow, /personal_access_token:\s*\$\{\{ secrets\.HOMEY_PAT \}\}/);
assert.doesNotMatch(workflow, /homey app publish|HOMEY_TOKEN|ATHOM_TOKEN/i);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/unit/publish-readiness.test.js
```

Expected: FAIL because the existing workflow has mutable v4 action references and no `release` or `publish` jobs.

- [ ] **Step 3: Pin existing actions and add release detection**

Replace all checkout references with:

```yaml
uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
```

Replace all setup-node references with:

```yaml
uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
```

Add this job:

```yaml
  release:
    name: Detect versioned release
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    outputs:
      changed: ${{ steps.version.outputs.changed }}
    steps:
      - name: Check out repository history
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          fetch-depth: 0
      - name: Detect app version change
        id: version
        shell: bash
        run: |
          before="${{ github.event.before }}"
          current="$(node -p "require('./.homeycompose/app.json').version")"
          changed=true
          if [[ ! "$before" =~ ^0+$ ]] && git cat-file -e "$before:.homeycompose/app.json" 2>/dev/null; then
            previous="$(git show "$before:.homeycompose/app.json" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(JSON.parse(value).version));")"
            [[ "$current" != "$previous" ]] || changed=false
          fi
          echo "changed=$changed" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 4: Add the protected publish job**

Append:

```yaml
  publish:
    name: Publish Homey Draft
    if: needs.release.outputs.changed == 'true'
    needs: [test, homey-validate, dependency-audit, release]
    runs-on: ubuntu-latest
    environment: homey-test
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
      - name: Publish Draft
        id: publish
        uses: athombv/github-action-homey-app-publish@0642b483f1eb66fbceb0c91b73df35d45fd2f3db
        with:
          personal_access_token: ${{ secrets.HOMEY_PAT }}
      - name: Add management URL to summary
        run: echo "Manage the Homey Draft at ${{ steps.publish.outputs.url }}" >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 5: Verify GREEN and workflow invariants**

Run:

```bash
node --test test/unit/publish-readiness.test.js
npm test
homey app build
git diff --exit-code -- app.json
homey app validate --level publish
npm audit --omit=dev --audit-level=high
git diff --check
```

Expected: all 154 tests pass, Homey validation succeeds, audit exits zero, and `app.json` remains unchanged.

- [ ] **Step 6: Scan for credential values and commit**

Run:

```bash
git grep -nE 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|HOMEY_PAT[=:][[:space:]]*[A-Za-z0-9._-]{10,}|Bearer eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' -- ':!docs/superpowers/**'
```

Expected: no matches. Then commit:

```bash
git add .github/workflows/validate.yml test/unit/publish-readiness.test.js
git commit -m "ci: publish versioned Homey drafts"
```

### Task 3: GitHub configuration and end-to-end delivery

**Files:**
- Modify through GitHub: repository secret `HOMEY_PAT` and environment `homey-test`.
- No repository file changes expected unless CI reveals a defect.

**Interfaces:**
- Consumes: the Homey app-owner PAT, green pull-request checks, and release `1.0.5`.
- Produces: merged `main`, successful Draft build, and active Homey Test release `1.0.5`.

- [ ] **Step 1: Create the GitHub deployment environment**

```bash
gh api --method PUT repos/shejnowicz/homey-vasco-kermi-x/environments/homey-test
```

Expected: GitHub identifies the `homey-test` environment.

- [ ] **Step 2: Configure `HOMEY_PAT` without displaying its value**

Open the repository Actions secret form or run:

```bash
gh secret set HOMEY_PAT --repo shejnowicz/homey-vasco-kermi-x
```

Expected: `gh secret list --repo shejnowicz/homey-vasco-kermi-x` lists `HOMEY_PAT`; its value is never printed.

- [ ] **Step 3: Push and open a pull request**

```bash
git push -u origin feature/automatic-homey-publish
gh pr create --base main --head feature/automatic-homey-publish --title "ci: automate versioned Homey Draft publishing" --body "Publishes validated versioned releases to Homey Draft after merge to main, while non-release merges skip publishing."
```

Expected: GitHub returns the pull-request URL.

- [ ] **Step 4: Verify pull-request behavior**

```bash
gh pr checks --watch
```

Expected: tests, Homey validation, and dependency audit pass; release detection and publishing are skipped for the pull request.

- [ ] **Step 5: Merge and verify automatic publication**

```bash
gh pr merge --squash --delete-branch
gh run list --branch main --limit 1
gh run watch --exit-status
```

Expected: validation and release detection pass; `Publish Homey Draft` uploads version `1.0.5` successfully and reports its Developer Tools URL.

- [ ] **Step 6: Enable and verify Homey Test**

Enable build `1.0.5` for Test in Homey Developer Tools without submitting for certification or publishing to Live. Verify the public Test URL returns HTTP 200:

```bash
curl -fsSIL https://homey.app/en-us/app/com.shejnowicz.vasco-kermi-x/test/
```

