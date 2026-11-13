# Security model

This document states what Integrity protects against, what it does not, and
what an operator has to do for the protection to mean anything. It is written
to be read alongside [SECURITY.md](../SECURITY.md), which covers vulnerability
reporting.

## Purpose

Integrity answers one question: _has this directory tree changed since a state
I chose to trust?_ It records a baseline, then compares the live tree with it.
It detects change. It does not prevent change, does not identify who made it,
and does not say whether a change was legitimate.

## Assets and assumptions

Assets:

- the **monitored files**, whose modification, addition, removal or
  substitution should be noticed;
- the **baseline**, the reference against which change is judged;
- the **key**, when baselines are signed;
- the **report**, which an operator reads and may act on.

Assumptions:

- The baseline was taken while the tree was in a state the operator trusted.
  Integrity cannot know that; a baseline of a compromised tree faithfully
  records the compromise.
- The host's kernel, the Node.js runtime and the Integrity installation itself
  are not controlled by the adversary at the time of verification.
- The operator can store the baseline or the key somewhere the adversary cannot
  reach, if the adversary is expected to be able to modify the monitored files.

## Adversaries

| Adversary                                                                            | Covered?                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Accidental change, corruption, a bad deployment                                      | Yes, with an unsigned baseline.                                                              |
| An unprivileged process or user that can change monitored files but not the baseline | Yes, with an unsigned baseline kept out of its reach.                                        |
| An attacker who can rewrite both the monitored files and the baseline                | **No** with a plain baseline. Yes with a signed baseline and a key the attacker cannot read. |
| An attacker who can rewrite files, baseline **and** read the key                     | No.                                                                                          |
| An attacker who controls the host (root, kernel, Node.js, or the Integrity code)     | No.                                                                                          |
| A malicious baseline, configuration file or saved report supplied as input           | Handled as untrusted input; see below.                                                       |
| A malicious file name or directory layout in the monitored tree                      | Handled; see below.                                                                          |

## Guarantees

These are properties the implementation is built to have.

**Detection**

- A modified regular file is reported when its SHA-256 digest differs from the
  recorded one. The digest covers the whole contents, streamed, regardless of
  size, unless the file is above the size limit (see non-guarantees).
- Added, removed and type-changed entries are reported. A file replaced by a
  symbolic link, or the reverse, is `critical`.
- A symbolic link is recorded by hashing its target string, so repointing it is
  reported as a modification. Links are not followed unless `--follow-symlinks`
  is given, so an attacker cannot extend the scan's reach by planting a link.
- Permission and ownership changes are reported when metadata was recorded and
  `--metadata` is in effect (the default). Modification-time differences on
  otherwise identical files are reported only with `--mtime`.

**No false reassurance**

- A verification is reported as clean only when every baseline entry and every
  live entry was checked. Unreadable files, directories that could not be
  listed, files above the size limit, entries of unsupported type, and anything
  skipped by depth, filesystem or cycle rules make the result `incomplete`
  (exit 2), or `changes-detected` when there are also changes. "Not checked" and
  "unchanged" are never conflated.
- An unrecognised option or configuration key is an error. A misspelt
  `--exclude` cannot silently produce a clean result.
- `verify` cannot update the baseline. The only way to replace a baseline is
  `scan --force`, which is an explicit act. `scan` without `--force` never
  overwrites an existing baseline.
- A signed baseline checked without a key is reported as `unverified`, which is
  visibly distinct from `valid`. A key supplied for an unsigned baseline is
  treated as a failed check, because the baseline may have been replaced with an
  unsigned copy.
- A baseline that fails validation or its signature check exits with status 3,
  which is distinct from "changes detected" (1).
- `verify`, `report` and `watch` use the scan options recorded in the baseline,
  so command-line options cannot narrow the scope of a verification relative to
  its baseline. Extra `--exclude` patterns can narrow it in `verify` and
  `report`; they are visible on the command line but are not recorded in the
  report. (`watch` ignores them.)

**Baseline handling**

- Baselines are written atomically (temporary file created with `O_EXCL`,
  `fsync`, rename), with mode `0600`, so a crash or full disk leaves the old or
  the new baseline and never a partial file.
- Baselines are validated field by field before use. Entries with absolute
  paths, `..` segments, NUL bytes, duplicate paths, malformed digests or invalid
  types cause the whole baseline to be rejected. A newer schema version is
  rejected rather than misread. Files over 512 MiB are refused unparsed.
- The file is opened once for hashing, and size, modification time and
  permissions are read from that descriptor, so the metadata describes the bytes
  that were hashed even if the path is replaced between operations.

**Signing**

- The HMAC-SHA-256 tag covers the canonical encoding of every field of the
  baseline except the signature, including options, entries and skipped
  entries. Changing any of them invalidates it.
- The tag is compared in constant time.
- The key is never written to the baseline, a report, a log or an error
  message, and there is no command-line option that takes the key as an
  argument. Keys shorter than 16 bytes are rejected.
- The key identifier (`--key-id`) is a plain label. It is not secret and is not
  authenticated separately, although as part of the baseline it is covered by
  the tag.

**Traversal and output**

- Traversal records directories by device and inode, so symlink cycles end.
  Depth is limited (default 64), and memory is flat with file size.
- Paths are checked to remain inside the scan root while walking.
- Control characters, C1 controls and bidirectional override characters in file
  names are escaped before being printed to a terminal, so a crafted name cannot
  rewrite earlier output to fake a clean result.
- No root privileges are required. Files the user cannot read are reported as
  unreadable rather than hidden or silently skipped.
- The program makes no network connections and has no runtime dependencies.

## Non-guarantees

These are limits an operator must plan around.

**A plain baseline is not authentic.** A SHA-256 hash proves nothing about who
produced it. An attacker who can rewrite a monitored file can usually rewrite the
baseline next to it and recompute the hashes, and the next `verify` will report
the tree as clean. An unsigned baseline detects accidents and attackers who
cannot reach the baseline. The tool prints this reminder on `scan` and in the
`Trust` line of every report.

To rely on a baseline against an attacker who can modify the monitored files:

- keep the baseline on storage the attacker cannot write to (a removable or
  read-only medium, another host, a store with separate permissions), or
- sign it, and keep the key where the attacker cannot read it (a removable
  device, a secrets manager, another host), and always run `verify` with that
  key so the result is `valid` rather than `unverified`.

Keeping the baseline inside the monitored directory (the default location) is
convenient and is excluded automatically, but gives no protection against an
attacker who can write there.

**A signature does not prove freshness.** The tag shows the baseline has not
been altered since it was signed with that key. It does not show when it was
signed, and an older validly signed baseline can be substituted for a newer one.
If rollback matters, record or compare `createdAt` and the signature value
through a separate channel.

**Not an atomic snapshot.** Hashing a live tree takes time, and files can change
while a scan or verification is running. Each entry's size, modification time
and digest are read from one descriptor and are consistent with each other, but
the tree as a whole is not a point-in-time image. A file may be changed after it
was hashed and before the run finishes; a change made and reverted between two
runs is not seen at all.

**Detection after the fact.** Integrity reports differences when it runs. It
does not block writes, and a verification only covers the state at the moment of
the check. `watch` narrows the gap between checks but does not remove it (see
below).

**Watch mode is best effort between full verifications.**

- Filesystem watchers coalesce and drop events under load, and behave
  differently on each platform.
- They cannot see changes made while `watch` is not running.
- Where recursive watching is unavailable, only the top level is watched.
- A change made and undone within one interval may never be observed.
- The periodic full verification (`--interval`, default 300 seconds) is the
  authoritative check. Setting `--interval 0` removes it and leaves only the
  watcher, which is not recommended.
- `watch` reads the baseline and checks its signature once, at start-up. A
  baseline replaced afterwards is not noticed until `watch` is restarted.

**Coverage is only as wide as the configuration.**

- Excluded paths are not monitored. The default exclusions (`.integrity/`,
  `.git/`, `node_modules/`, `*.log`, `*.tmp`) are a convenience, not a security
  recommendation; review them for the directory in question.
- Files above `maxFileSizeBytes` (default 512 MiB) are not hashed. They are
  recorded as skipped and make every verification `incomplete`, but their
  contents are not checked.
- Directories deeper than `maxDepth` (default 64) and, with
  `--one-file-system`, directories on other filesystems are not scanned and are
  reported the same way.
- Only regular files and symbolic links are recorded. Other file types
  (sockets, devices) are listed as skipped. Extended attributes, access control
  lists, file flags and hard-link relationships are not recorded. Directory
  metadata (permissions, ownership, modification time) is not recorded, and an
  empty directory that is added or removed is not reported.
- Metadata comparison covers permission bits, uid and gid, and, with
  `--mtime`, modification time. Modification-time-only differences are not
  findings unless `--mtime` is given.

**Local trust.**

- A verification run by an account that cannot read some files will be
  `incomplete`, which is the intended behaviour, but it cannot assess those
  files. Running with more privilege than necessary is not required and not
  recommended.
- If an attacker can replace the Integrity installation, the Node.js runtime or
  the kernel, any output is untrustworthy.
- A saved JSON report is not authenticated. `integrity report --input` renders
  whatever it is given and derives the exit code from the file's `status`
  field. It is for reading the tool's own output back, not a trust boundary.
- A report or baseline may contain file paths and metadata that are sensitive;
  both are written with mode `0600` when created, but the operator is
  responsible for where they are stored.

## Handling untrusted input

| Input                            | Treatment                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Baseline file                    | Size-limited, parsed as JSON, validated in full. Entry paths must be relative, free of NUL and `..`. Rejection exits with 3. |
| Configuration file               | Parsed as JSON and validated. Unknown keys and invalid patterns are errors (exit 64).                                        |
| Saved report (`--input`)         | Checked only for the fields needed to render it. Not a trust boundary.                                                       |
| File names in the monitored tree | Escaped before terminal output. Never interpreted as paths outside the root.                                                 |
| Exclusion patterns               | A small dialect compiled by the program. Empty patterns and `..` are rejected.                                               |
| Environment                      | `INTEGRITY_KEY`, `NO_COLOR`, `FORCE_COLOR` and `TERM` are read; nothing else.                                                |

## Operational guidance

1. Take the baseline only when the tree is in a state you trust, and note how
   you decided that.
2. For anything where an attacker may be able to write to the monitored tree,
   sign the baseline and keep the key off the host (or off the writable
   storage). Verify with the key.
3. Store baselines away from the tree they describe.
4. Run `verify` from a trusted context on a schedule (for example from a
   scheduler on another account or host), and treat exit codes 2 and 3 as
   alerts, not as noise.
5. Do not re-baseline to make an alert go away. Investigate first; then run
   `scan --force` deliberately.
6. Use `watch` for timeliness, but keep the periodic verification enabled.
7. Keep the exclusion list short and review it.
8. Be aware that `unverified` (a signed baseline checked without a key) is not
   a successful verification of the baseline's authenticity.

## Reporting a weakness

If you find a way to make Integrity report a clean result when it should not,
or to make it read or write outside the paths it was given, see
[SECURITY.md](../SECURITY.md) for how to report it privately.
