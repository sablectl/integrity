# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0   | No        |

Security fixes are made against the latest release in the supported line.

## Reporting a vulnerability

Please do not report security vulnerabilities through public issues, pull
requests or discussions.

Report them privately using GitHub Security Advisories for this repository:

1. Open <https://github.com/sablectl/integrity/security/advisories/new>
   (the "Report a vulnerability" button on the repository's Security tab).
2. Describe the problem, the affected version, and steps to reproduce it.
   A minimal directory layout, baseline or command line is the most useful
   thing to include.
3. State what you believe the impact to be.

You can expect an acknowledgement of your report, and a follow-up once it has
been assessed. Please allow reasonable time for a fix before any public
disclosure. Reporters are credited in the advisory unless they prefer
otherwise.

## What counts as a vulnerability

Examples of issues that are in scope:

- A way to make `verify` or `watch` report a clean result when entries were
  changed, removed or left unchecked.
- A baseline, configuration file or saved report that causes the tool to read
  outside the scan root or to write anywhere other than where it was asked to.
- A way to make a signed baseline pass verification without the key.
- Terminal output manipulation through crafted file names.
- A crash or unbounded resource use triggered by a crafted baseline, report or
  directory tree.

Out of scope: limitations that are documented in
[docs/security-model.md](docs/security-model.md), such as the absence of
authenticity for unsigned baselines, or an attacker who already controls both
the monitored host and the key.

## Threat model summary

The full model is in [docs/security-model.md](docs/security-model.md). In short:

- **Integrity detects change; it does not prevent it.** It compares the
  current state of a directory with a recorded one.
- **A plain SHA-256 baseline provides no authenticity** against an attacker who
  can rewrite both a monitored file and the baseline. Protect the baseline by
  storing it where that attacker cannot write, or sign it with an HMAC-SHA-256
  key (`--key-file` or `$INTEGRITY_KEY`) that the attacker cannot read.
- **A signed baseline checked without a key is "unverified"**, which is reported
  distinctly from "verified".
- **Incomplete is not clean.** Entries that were skipped or unreadable make the
  result incomplete (exit code 2).
- **Inputs are untrusted.** Baseline paths are validated, symbolic links are not
  followed by default, and control characters in file names are escaped.
- **A live tree is not an atomic snapshot.** Files can change during a scan.
- **A compromised host is out of scope.** If the operating system, the Node.js
  runtime or this tool's own files are controlled by an attacker, its output
  cannot be trusted.
- Integrity does not require root, makes no network connections, and has no
  runtime dependencies.
