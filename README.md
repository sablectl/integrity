# Integrity

**File Integrity Monitoring Toolkit** — cryptographic baselines, change
verification and directory monitoring for the command line.

[![CI](https://github.com/sablectl/integrity/actions/workflows/ci.yml/badge.svg)](https://github.com/sablectl/integrity/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Integrity records the state of a directory tree as a baseline, then tells you
what has changed since. It has no runtime dependencies, does not require root
privileges, and does not modify the directory it watches.

## What it does

- Walks a directory and records a SHA-256 digest of every regular file,
  hashed with streaming reads so memory use does not grow with file size.
- Writes a deterministic JSON baseline (entries sorted by path, schema
  version 1), atomically, with file mode `0600`. An existing baseline is never
  overwritten without `--force`.
- Compares a directory with its baseline and reports modified, added,
  removed, type-changed and metadata-changed entries.
- Never reports a run as clean when any entry could not be checked. Such a
  run is reported as incomplete and exits with status 2.
- Optionally signs the baseline with HMAC-SHA-256, so that a tampered
  baseline is detected by anyone who holds the key.
- Monitors a directory with a filesystem watcher backed by a periodic full
  verification.

There is deliberately no way to re-baseline from `verify`. Replacing the
trusted state is always an explicit `scan --force`.

## Requirements

- Node.js 20.19 or later.
- A POSIX-style filesystem is the intended environment. Other platforms have
  not been verified.

## Install

Integrity is distributed through GitHub only. Build it from source:

```sh
git clone https://github.com/sablectl/integrity.git
cd integrity
npm ci
npm run build
```

Run it directly:

```sh
node dist/bin/integrity.js --help
```

or make an `integrity` command available on your path:

```sh
npm link
integrity --help
```

## Quick start

Write a configuration file (optional, but it keeps `scan`, `verify` and
`watch` in agreement about what is protected):

```sh
integrity init ./app
```

Record the trusted state. Do this only when the directory is in a state you
are prepared to trust:

```console
$ integrity scan ./app
Scanning /srv/app
Baseline written to app/.integrity/baseline.json
  2 files, 0 symlinks, 10 B hashed in 8 ms

  This baseline is unsigned. Store it where an attacker who can modify
  the monitored files cannot modify it, or sign it with --key-file.
```

Check it later:

```console
$ integrity verify ./app
Integrity verification
  Root        /srv/app
  Baseline    /srv/app/.integrity/baseline.json
  Recorded    2025-11-13T15:45:59.681Z
  Checked     2025-11-13T15:45:59.946Z
  Trust       unsigned — detects accidents, not an attacker who can also rewrite the baseline

MEDIUM   added        extra.txt
           Present on the filesystem, missing from the baseline.
HIGH     modified     src/main.txt
           Contents differ from the baseline.
           Size 6 → 14 bytes.

Summary
  2 baseline entries checked in 7 ms
  1 unchanged, 1 modified, 1 added, 0 removed

CHANGES DETECTED
$ echo $?
1
```

Monitor continuously:

```sh
integrity watch ./app
```

For a baseline whose authenticity matters, sign it with a key kept outside the
monitored host or tree:

```sh
head -c 32 /dev/urandom | base64 > /media/usb/integrity.key
integrity scan /srv --key-file /media/usb/integrity.key --key-id prod-2025
integrity verify /srv --key-file /media/usb/integrity.key
```

## Commands

| Command  | Purpose                                                   |
| -------- | --------------------------------------------------------- |
| `init`   | Write a configuration file for a directory.               |
| `scan`   | Record a cryptographic baseline of a directory.           |
| `verify` | Check a directory against its baseline.                   |
| `watch`  | Monitor a directory and verify it as it changes.          |
| `report` | Render a verification report, fresh or from a saved file. |

Global options: `-h, --help`, `-v, --version`, `--no-color`, `-q, --quiet`.
The full reference is in [docs/commands.md](docs/commands.md).

## Exit codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | Clean. Every recorded entry was checked and matches the baseline. |
| 1    | Changes detected.                                                 |
| 2    | Incomplete. Nothing changed, but something could not be checked.  |
| 3    | Baseline missing, malformed, or failed its integrity check.       |
| 4    | Runtime error.                                                    |
| 64   | Invalid usage.                                                    |
| 130  | Interrupted.                                                      |

## Security notes

A plain SHA-256 baseline detects accidental change and change made by someone
who cannot also modify the baseline. It does **not** provide authenticity
against an attacker who can rewrite both a monitored file and the baseline:
that attacker can simply record the new hashes. To close that gap, either keep
the baseline where the attacker cannot write to it, or sign it with
`--key-file` (or `$INTEGRITY_KEY`) and keep the key out of the attacker's
reach. A baseline that is signed but verified without a key is reported as
"unverified", which is distinct from "verified".

Other properties worth knowing:

- Symbolic links are not followed by default. A link is recorded by hashing
  its target string, so repointing a link is reported as a modification.
- Baseline paths are validated as untrusted input; absolute paths, NUL bytes
  and `..` segments are rejected.
- Control characters in file names are escaped before they are printed.
- Integrity never needs root. Files it cannot read are reported, not hidden.

Read [docs/security-model.md](docs/security-model.md) for the threat model,
guarantees and non-guarantees. To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Configuration

Settings can be stored in `integrity.config.json` in the scanned directory.
Precedence is command line, then configuration file, then built-in default.
See [docs/configuration.md](docs/configuration.md).

## Performance

Hashing runs behind a bounded worker pool (`--concurrency`, default 8) and
reads files in 64 KiB chunks, so memory use is governed by the number of
recorded entries rather than by the size of the largest file.

`npm run bench` builds a synthetic tree, scans it, verifies it, and prints
what it measured together with the machine it measured it on. One run, on one
machine, for scale only:

```text
  Platform      Linux 7.2.15 (x64), Node v26.3.1
  CPU           Intel Core i7-8750H @ 2.20GHz x12
  Files         5000 (4 KiB each, 19.5 MiB total), concurrency 8

  Scan          463 ms  (42.2 MiB/s, 10810 files/s)
  Verify        487 ms  (40.1 MiB/s)
  Heap in use   16.6 MiB
```

These figures depend on storage, filesystem and cache state. Run the
benchmark on the hardware you care about rather than relying on the numbers
above.

## Documentation

- [Command reference](docs/commands.md)
- [Configuration](docs/configuration.md)
- [Baseline format](docs/baseline-format.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Technical debt](docs/technical-debt.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Limitations

- Hashing a live tree is not an atomic snapshot. Files may change while a
  scan or verification is running. Integrity records the size and modification
  time from the same file descriptor it hashed, so each entry is internally
  consistent, but the tree as a whole is not a point-in-time image.
- Filesystem watchers coalesce and drop events, cannot see changes made while
  `watch` is not running, and behave differently across platforms. The
  periodic full verification is the authoritative check.
- Without a key, the baseline offers no authenticity (see above).
- Integrity reports changes after the fact. It does not prevent them, and it
  does not detect compromise of the host it runs on.
- Only regular files and symbolic links are recorded. Other file types are
  listed as skipped.

## Licence and author

Released under the [MIT licence](LICENSE).

Written by Sable (<https://github.com/sablectl>) — <https://sablectl.dev>.
