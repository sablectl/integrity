# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-11-13

Initial release.

### Added

- `integrity init`: writes an `integrity.config.json` containing the default
  exclusions and limits. It never creates a baseline.
- `integrity scan`: walks a directory, hashes every regular file with
  SHA-256 using streaming reads, and writes a baseline (schema version 1).
  Entries are sorted by path so the output is deterministic. The baseline is
  written atomically with mode `0600`, and an existing baseline is never
  replaced without `--force`.
- `integrity verify`: re-hashes a directory and compares it with the
  baseline, reporting modified, added, removed, type-changed and
  metadata-changed entries. A run in which any entry could not be checked
  is reported as incomplete and never as clean. There is deliberately no
  option to update the baseline from `verify`.
- `integrity watch`: filesystem monitoring with debounced event-triggered
  verification and a periodic full verification (default every 300 seconds)
  as the authoritative check. Supports `--debounce`, `--interval`,
  `--max-pending`, `--once` and newline-delimited JSON output.
- `integrity report`: renders a verification report, either freshly
  produced or read from a JSON file written by `integrity verify --json`.
- Optional HMAC-SHA-256 keyed baselines through `--key-file`,
  `$INTEGRITY_KEY` and `--key-id`. A signed baseline checked without a key is
  reported as unverified, which is distinct from verified.
- Symbolic links are not followed by default and are recorded by hashing the
  link target string. `--follow-symlinks` opts in; directory cycles are
  detected by device and inode.
- `--one-file-system`, `--max-depth`, `--max-file-size`, `--concurrency` and
  repeatable `--exclude` glob patterns.
- Configuration through `integrity.config.json`, with the precedence
  command line, then configuration file, then built-in default.
- Path traversal checks on every baseline entry, and escaping of control
  characters in paths written to the terminal.
- Exit codes: 0 clean, 1 changes detected, 2 incomplete, 3 baseline missing,
  malformed or failed its integrity check, 4 runtime error, 64 invalid
  usage, 130 interrupted.
- Zero runtime dependencies. Requires Node.js 20.19 or later.

[1.0.0]: https://github.com/sablectl/integrity/releases/tag/v1.0.0
