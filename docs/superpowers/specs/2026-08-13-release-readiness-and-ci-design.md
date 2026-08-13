# Release Readiness and CI Design

## Goal

Prepare the community app for a Homey App Store Test release and contribute the
completed implementation through a protected GitHub pull request. The repository
uses `main`; no `master` branch is created.

## Store identity and copy

Rename the app to `Vasco/Kermi Ventilation` in English and
`Wentylacja Vasco/Kermi` in Polish. Use concise Store descriptions that describe
the daily benefit without repeating the app name or using generic phrases such
as "adds support", "integrates", or "control devices".

Rewrite `README.txt` and `README.pl.txt` as accurate one-to-two-paragraph Store
summaries. They state that this is a community integration using the vendor cloud,
that it was developed and physically tested on Vasco X500, and that other Vasco
and Kermi D/T/X models require community verification. They describe current
capabilities without claiming a local Fireplace countdown, prior-mode
restoration, or an unsupported Stop mechanism.

Update public developer documentation and the compatibility issue form to use
the D/T/X scope consistently. Retain the explicit unofficial-project and
trademark disclaimer in the public repository documentation. The driver name
continues to identify a D/T/X ventilation unit.

## CI checks

Replace the single validation job with three independently visible checks on
every pull request and every push to `main`:

- `test`: Node.js 22, `npm ci`, then `npm test`;
- `homey-validate`: Node.js 22, `npm ci`, pinned Homey CLI `4.4.1`, build,
  generated-manifest cleanliness check, and publish validation;
- `dependency-audit`: Node.js 22, `npm ci`, then
  `npm audit --omit=dev --audit-level=high`.

The workflow also supports manual dispatch, uses read-only repository contents
permission, and cancels stale runs for the same pull request or branch. Third
party actions remain on official major-version tags already used by the project.
Publishing itself is not automated and no Homey token is stored in GitHub.

## Protected `main`

After the workflow has run successfully on the feature pull request, protect
`main` with:

- pull requests required for every change, including administrators;
- required up-to-date checks: `test`, `homey-validate`, and `dependency-audit`;
- all review conversations resolved before merge;
- zero required approving reviews, because the sole maintainer is also the
  normal pull-request author;
- force pushes and branch deletion disabled.

The repository is public, so anyone may fork it and open a pull request. The
only current collaborator with write/admin access is `shejnowicz`; therefore
only that account can merge. Do not grant additional write access as part of
this work.

## Integration workflow

Push `feature/initial-app` and open a pull request against `main`. The PR contains
the implementation, release copy, and CI workflow. Wait for all three checks,
then enable the branch protection requiring those exact check names. Do not merge
the pull request: the repository owner performs the final review and merge.

## Homey release path

Passing `homey app validate --level publish` makes the package technically
eligible for Homey Pro publication, but certification is not the next immediate
step. After the PR is merged:

1. publish the first Homey App Store build as a Test release;
2. install or upgrade from the Test channel and repeat pairing, device controls,
   Flow cards, external-state synchronization, and credential-error tests;
3. collect sanitized compatibility reports for additional D/T/X models;
4. fix Test feedback and then submit the app for Athom certification.

The initial public version should be promoted to `1.0.0` when preparing the
actual Store Test upload. The version bump and interactive `homey app publish`
are deliberately outside this PR unless the owner separately authorizes the
external Test publication.

## Verification

Before pushing:

- all unit tests pass;
- dependency audit reports no high or critical issues;
- Homey debug and publish validation pass;
- generated `app.json` matches Homey Compose input;
- Store and repository copy contain no stale Fireplace-session claims;
- secret-safety and packaging tests pass;
- the worktree is clean.

After pushing, verify the PR targets `main`, all three required checks complete,
and the GitHub protection endpoint reports the approved policy.
