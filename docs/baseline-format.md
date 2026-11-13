# Baseline format

A baseline is the trusted reference state of a directory tree. It is a single
UTF-8 JSON document, indented with two spaces and ending with a newline, so
that it can be reviewed, diffed and kept in version control. It carries an
explicit schema version so that a future format change is detected rather than
silently misread.

The current schema version is **1**. The only hash algorithm is `sha256`.

## Determinism

- `entries` and `skipped` are sorted by `path`, comparing UTF-16 code units, so
  two scans of an unchanged tree produce the same entries in the same order.
- Paths are relative to the scan root and always use `/` as the separator, so
  a baseline created on one machine can be read on another.
- Fields that differ between runs are `createdAt`, `tool.version` and, when
  files are touched, `mtimeMs`. Metadata fields (`mode`, `uid`, `gid`) depend on
  the machine the scan ran on.

## Example

A signed baseline for a directory containing one regular file and one symbolic
link (the `root`, hashes and times are those of a real run):

```json
{
  "schemaVersion": 1,
  "tool": {
    "name": "integrity",
    "version": "1.0.0"
  },
  "createdAt": "2026-11-13T15:49:36.463Z",
  "root": "/srv/t",
  "hashAlgorithm": "sha256",
  "options": {
    "exclude": ["/.integrity/baseline.json", "*.log"],
    "followSymlinks": false,
    "recordMetadata": true,
    "oneFileSystem": false,
    "maxFileSizeBytes": 536870912,
    "maxDepth": 64
  },
  "stats": {
    "files": 1,
    "symlinks": 1,
    "directories": 1,
    "totalBytes": 2,
    "skipped": 0
  },
  "entries": [
    {
      "path": "a.txt",
      "type": "file",
      "size": 2,
      "sha256": "87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7",
      "mtimeMs": 1794584976322,
      "mode": 420,
      "uid": 1000,
      "gid": 1000
    },
    {
      "path": "link",
      "type": "symlink",
      "size": 5,
      "sha256": "18b7cb099a9ea3f50ba899b5ba81e0d377a5f3b16f8f6eeb8b3e58cd4692b993",
      "mtimeMs": 1794584976322,
      "target": "a.txt",
      "mode": 511,
      "uid": 1000,
      "gid": 1000
    }
  ],
  "skipped": [],
  "signature": {
    "algorithm": "hmac-sha256",
    "keyId": "demo-key",
    "value": "9889ab54650955c1504b3966deb2a0a0b307b0209d150b966992bbb3485aad88"
  }
}
```

(The implicit `/.integrity/baseline.json` exclusion appears because the
baseline's default location is inside the scanned directory. `scan --stdout`
computes it the same way.)

## Top-level fields

| Field           | Type    | Required | Description                                                             |
| --------------- | ------- | -------- | ----------------------------------------------------------------------- |
| `schemaVersion` | integer | yes      | Format version. Currently `1`.                                          |
| `tool`          | object  | yes      | The program that wrote the baseline.                                    |
| `createdAt`     | string  | yes      | ISO 8601 timestamp (UTC) of when the baseline was created.              |
| `root`          | string  | yes      | Absolute path of the scan root at creation time. Informational only.    |
| `hashAlgorithm` | string  | yes      | Must be `"sha256"`.                                                     |
| `options`       | object  | yes      | Scan options in force, reused when verifying.                           |
| `stats`         | object  | yes      | Totals describing the recorded tree.                                    |
| `entries`       | array   | yes      | Recorded files and symbolic links, sorted by `path`.                    |
| `skipped`       | array   | no       | Entries that exist but could not be hashed. Treated as empty if absent. |
| `signature`     | object  | no       | Keyed integrity tag. Present only on signed baselines.                  |

`root` is not used to locate files when verifying; the directory given on the
command line is. A baseline can therefore be verified against a copy of the
tree at a different path.

### `tool`

| Field     | Type   | Description                             |
| --------- | ------ | --------------------------------------- |
| `name`    | string | `"integrity"`.                          |
| `version` | string | The version that produced the baseline. |

### `options`

The scan options that were in effect. Verification and watch reuse them so that
a run cannot disagree with its baseline about what was in scope.

| Field              | Type              | Description                                                    |
| ------------------ | ----------------- | -------------------------------------------------------------- |
| `exclude`          | array of strings  | Exclusion patterns, including the implicit baseline exclusion. |
| `followSymlinks`   | boolean           | Whether symbolic links were followed.                          |
| `recordMetadata`   | boolean           | Whether `mode`, `uid` and `gid` were recorded.                 |
| `oneFileSystem`    | boolean           | Whether directories on other filesystems were skipped.         |
| `maxFileSizeBytes` | integer or `null` | Largest file that was hashed, in bytes. `null` means no limit. |
| `maxDepth`         | integer or `null` | Deepest directory level scanned. `null` means no limit.        |

All six are required. Booleans must be booleans; the two limits must be
non-negative integers or `null`.

### `stats`

| Field         | Type    | Description                                                       |
| ------------- | ------- | ----------------------------------------------------------------- |
| `files`       | integer | Number of `file` entries.                                         |
| `symlinks`    | integer | Number of symbolic links recorded as `symlink` entries.           |
| `directories` | integer | Number of directories listed during the walk, including the root. |
| `totalBytes`  | integer | Sum of `size` over `file` entries.                                |
| `skipped`     | integer | Number of entries in `skipped`.                                   |

All five are required non-negative integers. They describe the scan; they are
informational and are not cross-checked against `entries` when the baseline is
read.

### `entries[]`

One object per recorded file or symbolic link.

| Field     | Type    | Required          | Description                                                                                                             |
| --------- | ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `path`    | string  | yes               | Path relative to the root, with `/` separators.                                                                         |
| `type`    | string  | yes               | `"file"` or `"symlink"`.                                                                                                |
| `size`    | integer | yes               | Size in bytes. For a symlink, the byte length of the link target.                                                       |
| `sha256`  | string  | yes               | 64 lowercase hexadecimal characters.                                                                                    |
| `mtimeMs` | number  | yes               | Modification time in milliseconds since the Unix epoch, truncated to an integer.                                        |
| `mode`    | integer | no                | POSIX permission bits (including setuid, setgid and sticky), as a decimal number. Present when `recordMetadata` was on. |
| `uid`     | integer | no                | Owner user id. Present when `recordMetadata` was on.                                                                    |
| `gid`     | integer | no                | Owner group id. Present when `recordMetadata` was on.                                                                   |
| `target`  | string  | yes for `symlink` | The link target exactly as stored in the link. Absent for files.                                                        |

How the values are derived:

- For a `file`, `sha256` is the SHA-256 of the contents. The file is opened
  once, and `size`, `mtimeMs`, `mode`, `uid` and `gid` are read from that same
  open descriptor as the contents are streamed, so they describe the bytes that
  were actually hashed even if the path is replaced meanwhile. `size` is the
  number of bytes actually read.
- For a `symlink` (the default for links), `sha256` is the SHA-256 of the
  target string encoded as UTF-8, and `size` is the byte length of that string.
  The link itself is inspected without following it (`lstat`), so repointing a
  link changes its hash and is reported as a modification.
- With `followSymlinks` on, a link to a file is recorded as a `file` entry at
  the link's path, with the target file's contents hashed. A link to a directory
  is descended into under the link's path.
- `mode` is the permission bits masked to the low twelve bits. `0o644` is
  recorded as `420` and `0o777` as `511`.

Validation rules applied when a baseline is read:

- `path` must be a non-empty string that is relative: it must not start with
  `/` or a drive prefix such as `C:\`, must not contain a NUL character, and
  must not contain a `..` segment.
- Duplicate paths are rejected.
- `type` must be `file` or `symlink`; a `symlink` must have a string `target`.
- `sha256` must match `^[0-9a-f]{64}$`.
- `size` must be a non-negative integer; `mtimeMs` must be a finite number.
- `mode`, `uid` and `gid` are kept only if they are numbers; otherwise they are
  treated as absent.

### `skipped[]`

Entries that exist on disk but could not be recorded. Verification repeats
the scan with the options recorded in the baseline, so these entries are
normally skipped again, and a skipped entry in the live scan is what makes a
verification report `incomplete` rather than `clean`. The `skipped` list in the
baseline is a record of the coverage gap at creation time; the comparison
itself is driven by the live scan.

| Field     | Type   | Description                                                     |
| --------- | ------ | --------------------------------------------------------------- |
| `path`    | string | Path relative to the root. May be empty for an unreadable root. |
| `reason`  | string | One of the reasons below.                                       |
| `message` | string | Human-readable detail. Treated as an empty string if absent.    |

| Reason             | Meaning                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `unreadable`       | A file, link or directory could not be read, or disappeared during the scan.  |
| `too-large`        | The file exceeds `maxFileSizeBytes`.                                          |
| `symlink`          | Accepted by the schema as a reason; not produced by this release.             |
| `other-filesystem` | The directory is on another filesystem and `oneFileSystem` is on.             |
| `max-depth`        | The directory is deeper than `maxDepth`.                                      |
| `unsupported-type` | Not a regular file, symlink or directory (for example a socket or device).    |
| `cycle`            | The directory has already been visited (device and inode); traversal stopped. |

Excluded paths are not recorded as skipped.

### `signature`

Present only when the baseline was signed with a key.

| Field       | Type   | Description                                                             |
| ----------- | ------ | ----------------------------------------------------------------------- |
| `algorithm` | string | Must be `"hmac-sha256"`.                                                |
| `keyId`     | string | Optional, non-secret label naming the key. Never contains key material. |
| `value`     | string | 64 lowercase hexadecimal characters: the HMAC-SHA-256 tag.              |

The tag is computed over the **canonical JSON encoding** of the baseline with
the `signature` member removed:

- object keys sorted by UTF-16 code unit, at every level;
- no insignificant whitespace;
- arrays in their given order;
- `undefined` properties omitted;
- `-0` encoded as `0`;
- non-finite numbers are an error.

The HMAC key is the raw key material (see the key rules in
[commands.md](commands.md#keys)). The tag is compared with a constant-time
comparison. Because the tag covers every other field, including `options`,
`entries` and `skipped`, changing any of them invalidates it.

The signature does not cover anything outside the document: it does not prove
when the baseline was created, and it does not bind the baseline to a
particular directory (`root` is covered but is informational only).

## Reading rules

A baseline is untrusted input. It may be truncated by a full disk, edited by
hand, produced by a newer release, or written by someone hostile.

- A file larger than 512 MiB (`536870912` bytes) is refused without parsing.
- Invalid JSON is rejected. The message recommends re-creating the baseline
  from a known-good state.
- `schemaVersion` must be an integer. A value greater than 1 is rejected with a
  message to upgrade Integrity or re-create the baseline. A value below 1 is
  rejected as unsupported.
- `hashAlgorithm` must be `sha256`.
- `createdAt` must be a parseable timestamp; `root` a non-empty string; `tool`
  an object with string `name` and `version`.
- All problems found are collected and reported together. A baseline that fails
  validation is rejected as a whole; it is never partially accepted, because
  half a trusted reference state silently stops protecting the files it
  dropped.
- Every rejection exits with status 3.
- Validation builds a new document from the fields it recognises. Unknown
  members, at the top level or inside entries, are dropped rather than
  rejected, and the signature is checked against that validated document. An
  unknown member added to a signed baseline is therefore ignored and has no
  effect on the result, but it is also not protected by the signature.
- Entries are re-sorted by `path` after validation, whatever order they had in
  the file.

## Writing rules

- Written as `JSON.stringify(baseline, null, 2)` followed by a newline.
- Written atomically: to a temporary file named `<baseline>.tmp-<12 hex digits>`
  in the same directory, created exclusively with `O_EXCL` and mode `0600`,
  flushed to disk, renamed over the target, and the directory entry flushed
  (where the platform supports it). If any step fails, the temporary file is
  removed.
- Missing parent directories are created with mode `0700`.
- An existing file is never replaced unless `--force` is given.

## Compatibility

Schema version 1 is the only version. A reader rejects a newer
`schemaVersion` rather than guessing. Changes that break this format will
increment the version.
