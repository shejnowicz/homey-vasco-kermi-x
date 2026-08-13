# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed private
data. Use GitHub's private vulnerability reporting from the repository Security
tab. If that option is unavailable, contact the maintainer at
shejnowicz@gmail.com with a concise, sanitized description and reproduction
steps.

Do not include passwords, access tokens, account exports, raw cloud responses,
private device identifiers, packet captures, or network captures. If additional
information is genuinely necessary, agree on a safe transfer method with the
maintainer first.

You can expect an acknowledgement within seven days. The maintainer will assess
impact, coordinate a fix, and agree on disclosure timing with the reporter.

## Supported versions

Security fixes are applied to the latest published version. Users should update
the Homey app before reporting an issue that may already be resolved.

## Credential handling

Credentials are kept in protected Homey device settings and are never intended
for source files, fixtures, logs, crash messages, issue reports, or version
control. Tests and examples must use synthetic data only.
