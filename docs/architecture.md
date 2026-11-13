# Architecture

Integrity is a TypeScript command-line program with no runtime dependencies. It
uses only the Node.js standard library (`node:fs`, `node:crypto`, `node:path`
and similar). It makes no network connections and starts no subprocesses.

## Layout

```text
src/
  bin/integrity.ts      Process entry point: signals, exit code, real streams.
  cli/
    run.ts              Command dispatcher. Takes argv, streams, env and cwd;
                        returns an exit code. Never calls process.exit.
    args.ts             Declarative argument parser.
    options.ts          Shared option definitions; merges CLI, config, defaults.
    help.ts             Help rendering.
    terminal.ts         stdout/stderr, colour and progress handling.
    exit-codes.ts       The exit code constants.
    commands/           init, scan, verify, watch, report.
  core/
    types.ts            The baseline data model.
    scan.ts             Directory traversal and hashing.
    hash.ts             Streaming SHA-256.
    baseline.ts         Build, validate, read and write baselines.
    verify.ts           Compare a scan with a baseline.
    signature.ts        HMAC-SHA-256 keyed baselines.
    canonical.ts        Canonical JSON encoding used for signing.
    watch.ts            Filesystem watching plus periodic verification.
    config.ts           Configuration file parsing and validation.
    exclude.ts          Exclusion glob dialect.
    paths.ts            Path handling and traversal checks.
    errors.ts           Error types that determine exit codes.
  report/
    human.ts            Human-readable report.
    json.ts             JSON report and newline-delimited event output.
    format.ts           Control-character escaping and formatting helpers.
  version.ts            Product name and version.
  index.ts              Package entry point.
```

The package entry points are declared in `package.json`: the `integrity`
executable is `dist/bin/integrity.js`, and `dist/index.js` is the package's
`main`/`exports` entry.

## Layers

The code is arranged so that the parts that decide what is trusted have no
knowledge of the terminal.

1. **`core/`** knows about files, hashes, baselines and comparisons. It does
   not print anything and does not read process state.
2. **`report/`** turns a `VerificationReport` into text or JSON.
3. **`cli/`** parses arguments, resolves options, calls `core/`, and maps the
   outcome to an exit code.
4. **`bin/`** is the only place that touches the real process: it wires
   `SIGINT` and `SIGTERM` to an `AbortSignal`, passes the real streams, and sets
   `process.exitCode`.

Because `run()` takes its streams, environment, working directory and abort
signal as arguments, the whole command line can be exercised in-process.

## Data flow

### scan

```text
args + config ──► resolveScanSettings ──► scanDirectory ──► buildBaseline
                                                                 │
                                       (key?) signBaseline ◄─────┘
                                                 │
                                           writeBaseline (atomic, 0600)
```

1. `resolveScanSettings` merges the command line, the configuration file and
   the built-in defaults (in that order of precedence), resolves the baseline
   path and adds the implicit exclusion of the baseline when it lies inside the
   scanned directory.
2. `scanDirectory` walks the tree and returns entries, skipped entries and
   statistics.
3. `buildBaseline` assembles the document; `signBaseline` adds the HMAC tag if a
   key was resolved.
4. `writeBaseline` writes it atomically, refusing to replace an existing file
   without `--force`.

### verify

```text
readBaseline ──► verifySignature ──► scanDirectory (baseline's options)
                                          │
                              compareWithBaseline ──► report ──► exit code
```

1. The baseline is read and validated. Failure is exit 3.
2. The signature is checked, giving `unsigned`, `unverified`, `valid` or
   `invalid`.
3. The directory is scanned using the scan options recorded in the baseline
   (extra `--exclude` patterns are added), so the run cannot disagree with its
   baseline about scope.
4. `compareWithBaseline` produces the report; the exit code is derived from the
   report's status.

### watch

`watchDirectory` runs two mechanisms: a recursive `fs.watch` on the root, and a
timer. The watcher feeds a debounced, bounded set of changed paths; either a
flush of that set or the timer starts a full `scanDirectory` plus
`compareWithBaseline`. The scan is always a full verification: events only
decide _when_ to check, not _what_ to check. See [Watch mode](#watch-mode).

## Scanning

`scanDirectory` has two phases.

**Traversal** is iterative, using a queue, so a deep tree cannot exhaust the
call stack. Each directory entered is recorded by device and inode, which makes
a directory cycle (for example one created by following symbolic links)
terminate instead of looping. For each directory entry:

- Symbolic links are handled first. Excluded links are ignored. Without
  `followSymlinks`, a link is read with `readlink`, inspected with `lstat`, and
  recorded as a `symlink` entry hashed over its target string. With
  `followSymlinks`, the link is resolved with `stat`: a directory target is
  queued (subject to the same cycle, depth and filesystem checks), a regular
  file target is queued for hashing, and anything else is skipped as
  `unsupported-type`.
- Directories are checked against the exclusion list, then against the depth
  limit, the one-file-system rule and the visited set before being queued.
- Regular files that are not excluded are queued for hashing.
- Anything else (sockets, devices and so on) is recorded as skipped with the
  reason `unsupported-type`.
- Every path is checked with `relativeInside` to confirm it is still inside
  the root.

**Hashing** runs behind a worker pool of `--concurrency` workers (default 8), so
a directory with a hundred thousand files opens a handful of descriptors at a
time. `hashFile` opens each file once, takes the metadata from that descriptor
(`fstat`), refuses it if it is not a regular file or exceeds the size limit, and
streams the contents through SHA-256 in 64 KiB chunks. The size limit is checked
again while reading, so a file that grows during hashing is still refused.
Memory use is independent of file size.

Anything that cannot be hashed is recorded in `skipped` with a reason and a
message. Nothing is silently dropped. A file that vanishes between listing and
hashing is reported as unreadable ("File disappeared during the scan.").

The result is sorted by path, giving deterministic output regardless of the
order in which the filesystem returns entries or in which the worker pool
finishes.

## Comparison

`compareWithBaseline` is a set difference over sorted relative paths:

1. For each baseline entry: missing from the scan and skipped in the scan is
   `unreadable`; missing and not skipped is `removed`; a different type is
   `type-changed`; a different digest is `modified`; identical digest but
   differing metadata (when requested) is `metadata`; otherwise unchanged.
2. For each scanned entry not in the baseline: `added`.
3. For each skipped entry not in the baseline: `unreadable`.

The status is `baseline-untrusted` if the signature is invalid, otherwise
`changes-detected` if there is any added, removed, modified, type-changed or
metadata finding, otherwise `incomplete` if anything was skipped or unreadable,
otherwise `clean`. A run is `complete` only when nothing was unreadable and the
scan skipped nothing.

## Signing

The tag is `HMAC-SHA-256(key, canonicalize(baseline without signature))`.
`canonicalize` sorts object keys, removes insignificant whitespace and rejects
values JSON cannot represent exactly, so there is exactly one byte sequence to
sign. Comparison uses `timingSafeEqual`. A baseline that is signed but checked
without a key is `unverified`, never `valid`; a key supplied for an unsigned
baseline is `invalid`.

## Watch mode

- A recursive filesystem watcher is started where the platform supports it.
  Otherwise the top level only is watched, with a warning; otherwise watching is
  disabled with a warning. Periodic verification covers the whole tree in every
  case.
- Events are debounced (`--debounce`, default 250 ms). Event paths matching the
  baseline's exclusions are ignored. The pending path set is bounded by
  `--max-pending` (default 5000); beyond that, the batch is marked truncated.
- Only one verification runs at a time. A request that arrives during a run
  queues one follow-up run.
- A full verification also runs every `--interval` seconds (default 300; 0
  disables it). This is the authoritative check.
- Aborting the signal stops the timers and the watcher and ends the session
  with a summary; cancellation is not an error inside the watcher.

## Error handling and exit codes

Every error that reaches the command layer is an `IntegrityError` with a kind:

| Kind        | Exit code | Typical cause                                                 |
| ----------- | --------- | ------------------------------------------------------------- |
| `usage`     | 64        | Bad arguments, unreadable key file, invalid configuration.    |
| `baseline`  | 3         | Missing, malformed or untrusted baseline; short key.          |
| `io`        | 4         | Cannot read the root, cannot write a file, refused overwrite. |
| `internal`  | 4         | Unexpected condition.                                         |
| `cancelled` | 130       | Interrupted.                                                  |

Any other thrown value is reported as a runtime error (4). The exit code is
chosen from the error's kind, never by matching message text, so a malformed
baseline cannot be mistaken for a clean run by a script reading `$?`.

For `verify` and `report`, successful runs return 0, 1, 2 or 3 depending on the
report status.

## Output

Everything intended for a script (reports, JSON, event lines, a baseline from
`--stdout`) goes to stdout. Progress, notes and errors go to stderr. Progress
lines are drawn only when stderr is a terminal. Colour is an enhancement: every
line reads the same without it.

Every path printed to a terminal passes through `escapeControlCharacters`,
which replaces control characters, C1 controls and the bidirectional override
characters U+202A to U+202E with visible escapes. Ordinary Unicode file names
are left readable. JSON output carries paths as JSON strings, which JSON itself
escapes.

## File writes

The program writes exactly three kinds of file, and only when asked:

| File          | Command                            | How                                                                           |
| ------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| Baseline      | `scan`                             | Temporary file, `fsync`, rename; mode `0600`; no overwrite without `--force`. |
| Configuration | `init`                             | Mode `0644`; exclusive create unless `--force`.                               |
| JSON report   | `verify`, `report` with `--output` | Plain write; mode `0600` when created.                                        |

It never modifies the monitored files.
