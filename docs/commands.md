# Command reference

```text
integrity <command> [options]
```

Commands: `init`, `scan`, `verify`, `watch`, `report`.

Running `integrity` with no arguments prints the root help and exits with
status 64. `integrity --help`, `integrity -h` and `integrity help` print it and
exit with status 0. `integrity help <command>` and `integrity <command> --help`
print the help for one command.

Unknown commands, unknown options and options missing a required value are
errors (exit status 64). An unrecognised option is never ignored: a tool that
answers "did anything change?" must not quietly disregard a misspelt
`--exclude`.

## Contents

- [Global options](#global-options)
- [Output streams](#output-streams)
- [Exit codes](#exit-codes)
- [Shared scan options](#shared-scan-options)
- [integrity init](#integrity-init)
- [integrity scan](#integrity-scan)
- [integrity verify](#integrity-verify)
- [integrity watch](#integrity-watch)
- [integrity report](#integrity-report)
- [Exclusion patterns](#exclusion-patterns)
- [Size values](#size-values)
- [Environment](#environment)

## Global options

```text
-h, --help       Show help. Use "integrity <command> --help" for details.
-v, --version    Print the installed version.
    --no-color   Disable colour. NO_COLOR is honoured automatically.
-q, --quiet      Suppress progress and informational output.
```

`--version` and `-v` are recognised only as the first argument:

```console
$ integrity --version
Integrity v1.0.0
```

Every command also accepts `-h, --help`, `--color` / `--no-color` and
`-q, --quiet`. Colour is used only when stdout is a terminal, and is disabled
when `NO_COLOR` is set (to any value), when `TERM` is `dumb`, or when
`--no-color` is given. `--color`, or a `FORCE_COLOR` value other than `0`,
forces it on. Colour never carries meaning that the text does not.

Short options take one letter each and cannot be combined: use `-q -j 4`, not
`-qj 4`. Long options accept `--name value` or `--name=value`. Boolean options
take no value. A bare `--` ends option parsing.

## Output streams

- Reports, baselines written with `--stdout`, JSON, and watch events go to
  **stdout**.
- Progress, informational notes (`-q` suppresses them) and error messages go to
  **stderr**.
- Progress redraws are written only when stderr is a terminal.

This keeps stdout a clean stream for `--json` and pipes.

## Exit codes

| Code | Name               | Meaning                                                               |
| ---- | ------------------ | --------------------------------------------------------------------- |
| 0    | clean              | Success. For `verify`, everything was checked and nothing changed.    |
| 1    | changes detected   | `verify` found differences from the baseline.                         |
| 2    | incomplete         | No changes found, but at least one entry could not be checked.        |
| 3    | untrusted baseline | Baseline missing, malformed, or failed its integrity check.           |
| 4    | runtime error      | An I/O or internal error, including refusing to overwrite a baseline. |
| 64   | invalid usage      | Bad command line, unreadable key file, or invalid configuration file. |
| 130  | interrupted        | The run was interrupted by SIGINT or SIGTERM.                         |

Notes:

- When a run has both changes and unchecked entries, the exit code is 1 and the
  report states that some entries could not be checked.
- A failed signature check (`invalid`) takes priority over every other result:
  the status is "baseline untrusted" and the exit code is 3, even if there are
  also changes.
- A baseline that does not exist, cannot be parsed, or fails schema validation
  exits with 3. So does a signing key that is too short (see [Keys](#keys)).
- On interruption, a run that would otherwise have exited 0 exits 130. A run
  with a non-zero result keeps that result. A second interrupt exits
  immediately with 130.
- `scan` exits 0 even when some entries had to be skipped; the skipped entries
  are listed in the baseline and mentioned on stderr. Because `verify` scans
  with the same options, those entries are normally skipped again and make the
  result incomplete.
- If a `scan` is refused because a baseline already exists, the exit code is 4.

## Shared scan options

`scan`, `verify`, `watch` and `report` accept these options.

| Option                    | Description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| `-b, --baseline <file>`   | Baseline file. Defaults to `<directory>/.integrity/baseline.json`.                |
| `-c, --config <file>`     | Configuration file. Defaults to `<directory>/integrity.config.json` when present. |
| `-e, --exclude <pattern>` | Exclude paths matching a glob. Repeatable. Adds to the configured list.           |
| `--follow-symlinks`       | Follow symbolic links. Off by default; links are recorded by their target string. |
| `--one-file-system`       | Do not descend into directories on another filesystem.                            |
| `--max-file-size <size>`  | Refuse to hash files above this size, for example `20M`. `off` removes the limit. |
| `--max-depth <n>`         | Maximum directory depth below the root. Integer from 0 to 4096.                   |
| `-j, --concurrency <n>`   | Number of files hashed at the same time. Integer from 1 to 1024.                  |
| `--key-file <file>`       | Key file for baseline signing and verification. Falls back to `$INTEGRITY_KEY`.   |
| `--key-id <label>`        | Non-secret label recorded alongside the signature.                                |

Behaviour that applies to all of them:

- The directory argument is optional and defaults to the current directory.
  More than one directory is a usage error.
- If `--config` is given and the file cannot be read, that is an error (64). If
  it is not given, `<directory>/integrity.config.json` is used when it exists,
  and silently skipped when it does not. A configuration file that exists but
  is malformed is always an error.
- A relative `--baseline` (or `baseline` key in the configuration file) is
  resolved against the scanned directory, not the current directory.
- If the baseline lives inside the scanned directory, it is excluded
  automatically (as an anchored pattern, `/.integrity/baseline.json` by
  default), so it is not reported as an added file. Keeping it outside the
  scanned tree is preferable; see [security-model.md](security-model.md).
- Exclusion patterns accumulate in this order: the implicit baseline exclusion,
  the configuration file's `exclude`, then `--exclude` options.

### Which options apply when verifying

A baseline records the scan options it was built with: `exclude`,
`followSymlinks`, `recordMetadata`, `oneFileSystem`, `maxFileSizeBytes` and
`maxDepth`. `verify`, `report` (without `--input`) and `watch` **reuse the
recorded values** so that a verification cannot disagree with its own baseline
about what was in scope.

In practice, for those commands:

- `--follow-symlinks`, `--one-file-system`, `--max-file-size` and `--max-depth`
  on the command line do not change what is scanned. The baseline's values are
  used. To change them, create a new baseline with `scan --force`.
- `--exclude` patterns are added to the baseline's recorded exclusions in
  `verify`, `report` and `watch`. Patterns already present are not duplicated.
  Exclusions can therefore narrow what a check looks at, but never widen it
  beyond what the baseline covers.
- `--concurrency` does apply.
- `--metadata`, `--mtime`, and the configuration keys `checkMetadata` and
  `checkMtime` control how the results are compared; see below.

## integrity init

```text
integrity init [directory] [options]
```

Creates `integrity.config.json` with the default exclusions and limits so that
`scan`, `verify` and `watch` all agree about what is being protected. No
baseline is created.

```text
Options:
  -h, --help   Show help for this command.
      --color  Force colour on or off. Colour is off when output is piped or NO_COLOR is set.
  -q, --quiet  Suppress progress and informational output on stderr.
  -f, --force  Overwrite an existing configuration file.
      --print  Write the configuration to stdout instead of to a file.
```

Behaviour:

- Without `--force`, an existing file is not touched; the command fails with
  exit status 4 and the message "already exists".
- `--print` writes the configuration to stdout and creates nothing.
- The file is created with mode `0644`.
- The directory must already exist.

```console
$ integrity init ./app
Wrote app/integrity.config.json

Next: review the exclusions, then record the trusted state with
  integrity scan ./app
```

The written contents are described in [configuration.md](configuration.md).

## integrity scan

```text
integrity scan [directory] [options]
```

Walks the directory, hashes every regular file with SHA-256, and writes a
baseline describing the state you are choosing to trust. Run it only when you
believe the directory is in a known-good state. An existing baseline is never
replaced without `--force`.

Accepts the [shared scan options](#shared-scan-options) and:

```text
-f, --force    Replace an existing baseline. Always an explicit choice.
    --stdout   Write the baseline to stdout instead of to a file.
```

Behaviour:

- The baseline is written atomically: to a uniquely named temporary file in the
  same directory (created exclusively, mode `0600`), flushed to disk, then
  renamed over the target. The parent directory is created (mode `0700`) if it
  does not exist. A crash leaves either the old baseline or the new one.
- Without `--force`, an existing baseline makes the command fail with exit
  status 4 and no change to the file:

  ```console
  $ integrity scan app
  Scanning /srv/app
  error: Refusing to overwrite the existing baseline at /srv/app/.integrity/baseline.json.
    Pass --force to replace it. Replacing a baseline is always explicit.
  ```

- With `--stdout`, the baseline is printed and no file is written or checked
  for.
- If a key is supplied (`--key-file` or `$INTEGRITY_KEY`) the baseline carries
  an HMAC-SHA-256 signature. Without one, a note on stderr says the baseline is
  unsigned.
- Entries that cannot be recorded (unreadable, too large, unsupported type,
  beyond the depth limit, on another filesystem, or a directory cycle) are
  stored under `skipped` in the baseline. At most ten are echoed to stderr.

Examples:

```sh
integrity scan
integrity scan /etc --baseline /secure/etc.baseline.json
integrity scan ./app --exclude "node_modules/" --exclude "*.log"
integrity scan /srv --key-file /media/usb/integrity.key --key-id prod-2025
```

## integrity verify

```text
integrity verify [directory] [options]
```

Re-hashes the directory and compares it with the baseline, reporting modified,
added, removed and type-changed entries, and listing anything that could not be
checked. A run with unreadable files never exits 0, because an unchecked file
is not an unchanged file.

There is deliberately no option to update the baseline from `verify`.

Accepts the [shared scan options](#shared-scan-options) and:

```text
    --metadata / --no-metadata   Compare permissions and ownership as well as contents.
    --mtime / --no-mtime         Report modification-time changes on files whose contents match.
    --json                       Write the report to stdout as JSON.
-o, --output <file>              Also write the JSON report to a file.
    --detailed                   Include recorded and observed digests for each finding.
    --summary                    Print only the summary, without per-file findings.
```

Defaults: `--metadata` is on (unless `checkMetadata` is false in the
configuration file) and `--mtime` is off. The help text lists the positive
forms; `--no-metadata` and `--no-mtime` switch them off.

### Outcomes and findings

Each finding has a change type and a severity:

| Change         | Severity | Meaning                                                                                  |
| -------------- | -------- | ---------------------------------------------------------------------------------------- |
| `type-changed` | critical | A file became a symlink or the reverse.                                                  |
| `modified`     | high     | Contents differ (or a symlink now points elsewhere).                                     |
| `removed`      | high     | In the baseline, missing from the filesystem.                                            |
| `added`        | medium   | On the filesystem, absent from the baseline.                                             |
| `unreadable`   | medium   | Could not be checked. A coverage gap, not a detected change.                             |
| `metadata`     | low      | Contents match, but permissions, ownership or (with `--mtime`) modification time differ. |

The overall status is derived as follows, in this order:

1. The signature check failed: `baseline-untrusted`, exit 3.
2. Any added, removed, modified, type-changed or metadata finding:
   `changes-detected`, exit 1.
3. Otherwise, any unreadable or skipped entry: `incomplete`, exit 2.
4. Otherwise: `clean`, exit 0.

Permission and ownership comparison happens only when both the baseline entry
and the live entry carry the values (that is, the baseline was recorded with
`recordMetadata` on). Ownership comparison reports uid and gid numerically.

Sample output:

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
```

The final line is one of:

- `OK — every recorded entry matches the baseline.`
- `CHANGES DETECTED` (with ` — and some entries could not be checked.` appended
  when the run was also incomplete)
- `INCOMPLETE — no changes were found, but some entries could not be checked. This is not a clean result.`
- `BASELINE UNTRUSTED — the baseline failed its integrity check. Do not rely on this result.`

The `Trust` line is one of: `signed, verified`, `signed, not verified — no key
supplied`, `signature check FAILED`, or `unsigned`, with the key id appended
when the baseline records one.

### Signature states

| State        | When                                                                                                           | Effect                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `unsigned`   | No signature in the baseline and no key supplied.                                                              | Reported as such.                                                          |
| `unverified` | The baseline is signed, but no key was supplied.                                                               | Reported distinctly from `valid`. Does not by itself change the exit code. |
| `valid`      | The signature matches the supplied key.                                                                        | Reported as verified.                                                      |
| `invalid`    | The tag does not match, the algorithm is unsupported, or a key was supplied but the baseline has no signature. | `baseline-untrusted`, exit 3.                                              |

A key supplied for an unsigned baseline is treated as a failed check, because
the baseline may have been replaced with an unsigned copy.

### JSON report

`--json` writes the report to stdout as indented JSON, replacing the human
report. `-o, --output <file>` additionally writes the same JSON to a file
(created with mode `0600`; an existing file is overwritten in place, and the
mode of an existing file is not changed). The JSON report has these top-level
fields:

| Field               | Description                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `tool`              | `{ name, version }` of the verifying tool.                                                                                 |
| `generatedAt`       | ISO 8601 time of the check.                                                                                                |
| `root`              | Absolute path that was verified.                                                                                           |
| `baselinePath`      | Path of the baseline used (when known).                                                                                    |
| `baselineCreatedAt` | The baseline's `createdAt`.                                                                                                |
| `signature`         | `{ status, reason?, keyId? }`; status is `unsigned`, `unverified`, `valid` or `invalid`.                                   |
| `status`            | `clean`, `changes-detected`, `incomplete` or `baseline-untrusted`.                                                         |
| `complete`          | `true` only when every baseline and live entry was checked.                                                                |
| `summary`           | Counts: `checked`, `unchanged`, `added`, `removed`, `modified`, `typeChanged`, `metadataChanged`, `unreadable`, `skipped`. |
| `findings`          | Sorted by path, then by change type.                                                                                       |
| `skipped`           | Entries skipped during the scan: `{ path, reason, message }`.                                                              |
| `durationMs`        | Duration of the scan.                                                                                                      |

Each finding has `path`, `change`, `severity`, `details` (strings) and, where
applicable, `expected` and `actual` snapshots with `type`, `size`, `sha256`,
`mtimeMs`, `mode`, `uid` and `gid`. The `--detailed` flag affects only the
human report; the JSON always carries the digests.

A report may contain sensitive paths. It is written to disk only when
`--output` is given.

Examples:

```sh
integrity verify
integrity verify /etc --baseline /secure/etc.baseline.json
integrity verify ./app --json > report.json
integrity verify /srv --key-file /media/usb/integrity.key --detailed
```

## integrity watch

```text
integrity watch [directory] [options]
```

Verifies the directory once, then watches it. Filesystem events are debounced
and trigger a verification; a full verification also runs on a timer, which is
what makes the result trustworthy.

Limits worth knowing: filesystem watchers coalesce and drop events under load,
cannot see changes made while this process was not running, and are not uniform
across platforms. The periodic verification, not the watcher, is the
authoritative check.

Accepts the [shared scan options](#shared-scan-options), the comparison options
of `verify` (`--metadata`, `--mtime`, `--json`, `--detailed`, `--summary`;
`--output` is not accepted), and:

```text
    --debounce <ms>         Quiet period before a batch of events triggers a check. Default 250.
    --interval <seconds>    Gap between full verifications. 0 disables them. Default 300.
    --max-pending <n>       Largest number of paths buffered between checks. Default 5000.
    --once                  Verify once and exit. Useful for testing the configuration.
```

Ranges: `--debounce` 0 to 60000, `--interval` 0 to 86400, `--max-pending` 1 to 1000000.

Behaviour:

- The baseline is read once at start-up, and its signature is checked once.
  Changes to the baseline file while `watch` runs are not picked up.
- An initial verification runs before watching begins. It is also the only
  check in `--once` mode, where periodic verification is disabled.
- A recursive watcher is used where the platform supports it. If it does not,
  only the top level of the directory is watched and a warning says so;
  periodic verification still covers the whole tree. If no watcher can be
  created at all, the command falls back to periodic verification only, with a
  warning.
- Events for paths that match the baseline's exclusions are ignored. Event
  paths are collected in a set bounded by `--max-pending`; past the limit, the
  set stops growing, the batch is marked as truncated, and the verification that
  follows establishes the truth.
- A verification is never run concurrently with another. If one is requested
  while one is running, a single follow-up is queued.
- A watcher error closes the watcher with a warning, and the periodic
  verification continues.
- `Ctrl-C` (SIGINT) or SIGTERM stops the session cleanly and prints a summary
  of the number of verifications and findings.
- If the baseline signature is `invalid`, every verification in the session is
  reported as `baseline-untrusted`.
- The exit code is the most severe result of any verification during the
  session, using the order 0 < 1 < 2 < 3 by numeric value. If no verification
  produced a non-zero result and the session was interrupted, the exit code is 130.

Human output, one line per event:

```console
$ integrity watch ./app --once --no-color
2025-11-13T15:46:00.436Z watching /srv/app
2025-11-13T15:46:00.444Z initial check: CHANGES — 1 modified, 1 added, 0 removed, 0 unchecked
2025-11-13T15:46:00.445Z   MEDIUM   added        extra.txt
2025-11-13T15:46:00.445Z   HIGH     modified     src/main.txt
2025-11-13T15:46:00.445Z stopped
  1 verification, 2 findings reported.
```

With `--json`, each event is one JSON object per line (newline-delimited JSON)
on stdout, and the closing summary is omitted:

```json
{"timestamp":"2025-11-13T15:46:00.572Z","event":"started","root":"/srv/app","recursive":true}
{"timestamp":"2025-11-13T15:46:00.581Z","event":"verification","trigger":"initial","status":"changes-detected","complete":true,"summary":{"checked":2,"unchanged":1,"added":1,"removed":0,"modified":1,"typeChanged":0,"metadataChanged":0,"unreadable":0,"skipped":0}}
```

Event kinds: `started` (`root`, `recursive`), `activity` (`paths`,
`truncated`), `verification` (`trigger` of `initial`, `activity` or `interval`;
`status`, `complete`, `summary`), `findings` (`findings` array), `warning`
(`message`) and `stopped` (`reason`).

Examples:

```sh
integrity watch
integrity watch /etc --interval 60
integrity watch ./app --json | tee integrity.ndjson
```

## integrity report

```text
integrity report [directory] [options]
```

With `--input`, reads a JSON report produced by `integrity verify --json` and
renders it. Use `-` to read from standard input. Without `--input`, runs a
verification and renders it with full detail (the same as `verify --detailed`,
unless `--summary` is given).

Exit codes match `integrity verify`, so a saved report re-rendered in CI still
fails the job it should fail.

Accepts the [shared scan options](#shared-scan-options), the comparison options
of `verify`, and:

```text
-i, --input <file>   Render a previously saved JSON report. "-" reads standard input.
```

Behaviour with `--input`:

- Only the `status`, `summary`, `findings` and `root` fields are required to be
  present. The input is a convenience for reading the tool's own output; it is
  not a trust boundary, and a hand-written file can claim any status.
- The exit code is derived from the `status` field in the file.
- The scan options (and any directory argument) are not used.
- `--json` re-emits the parsed report as JSON; `--detailed` is on by default and
  `--summary` hides the per-finding list.
- Empty standard input, an unreadable file, or invalid JSON is a usage error
  (64).

```sh
integrity report
integrity report --input report.json
integrity verify --json | integrity report --input -
```

## Exclusion patterns

Patterns are a small glob dialect, matched against paths relative to the scan
root, always written with `/` separators:

| Syntax                             | Meaning                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `*`                                | Any run of characters except `/`.                                 |
| `?`                                | Exactly one character except `/`.                                 |
| `**`                               | Any run of characters including `/`. `a/**/b` also matches `a/b`. |
| `[abc]`                            | One character from the set. `[!abc]` negates it.                  |
| trailing `/`                       | The pattern applies to directories only.                          |
| no `/` (other than a trailing one) | Matches that name at any depth, like `.gitignore`.                |
| leading `/`                        | Anchors the pattern to the scan root.                             |

A pattern that matches a directory also excludes everything below it. Empty
patterns and patterns containing a `..` segment are rejected. An invalid
pattern in a configuration file is reported when the file is loaded. Excluded
paths are not recorded and are not reported as added, removed or skipped.

## Size values

`--max-file-size` accepts an integer number of bytes, or an integer followed by
one of `b`, `k`, `kb`, `kib`, `m`, `mb`, `mib`, `g`, `gb`, `gib`
(case-insensitive). All suffixes are binary multiples: `20M` is 20 x 1024 x 1024
bytes. `off`, `none` and `unlimited` remove the limit. The built-in default is
512 MiB (536870912 bytes).

## Environment

| Variable        | Effect                                                                         |
| --------------- | ------------------------------------------------------------------------------ |
| `INTEGRITY_KEY` | Signing and verification key, used when `--key-file` is not given.             |
| `NO_COLOR`      | When set (any value), disables colour.                                         |
| `FORCE_COLOR`   | When set to anything other than `0`, enables colour (`--no-color` still wins). |
| `TERM`          | `dumb` disables colour.                                                        |

### Keys

- With `--key-file`, the key is the file's bytes with one trailing newline
  (LF or CRLF) removed. An unreadable key file is a usage error (64).
- With `INTEGRITY_KEY`, the key is the variable's UTF-8 bytes. An empty
  variable is treated as unset.
- A key must be at least 16 bytes long. A shorter key fails with exit 3 and a
  message suggesting how to generate one:

  ```sh
  head -c 32 /dev/urandom | base64 > integrity.key
  ```

- `--key-file` takes precedence over `INTEGRITY_KEY`.
- The key is never written to the baseline, report, logs or error messages.
  There is no option that takes the key itself as an argument; it is read from
  a file or from the environment.
- `--key-id` records a non-secret label in the signature. It is informational
  and is not checked during verification.
