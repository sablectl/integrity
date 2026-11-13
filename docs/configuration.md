# Configuration

Integrity reads an optional JSON configuration file so that `scan`, `verify`
and `watch` do not have to be given the same options every time, and cannot
accidentally be given different ones. A verification run with different
exclusions from the scan that produced the baseline reports differences that are
artefacts of the command line rather than events on disk.

## Location

- By default the file is `integrity.config.json` in the scanned directory.
- `--config <file>` selects another file. If it is given and cannot be read,
  the command fails with exit status 64.
- If `--config` is not given and the default file does not exist, the built-in
  defaults are used. A default file that exists but cannot be read or is
  invalid is an error.

`integrity init` writes a file containing the values below. Use
`integrity init --print` to see it without creating anything.

## Precedence

For every setting, the first source that provides a value wins:

1. The command line.
2. The configuration file.
3. The built-in default.

`--exclude` is the exception: exclusion patterns are cumulative. The effective
list is, in order, the implicit exclusion of the baseline file (when it lives
inside the scanned directory), the configuration file's `exclude`, then every
`--exclude` option.

Note that `verify`, `report` and `watch` take the scan options that define
scope (`exclude`, `followSymlinks`, `recordMetadata`, `oneFileSystem`,
`maxFileSizeBytes`, `maxDepth`) from the **baseline**, not from the
configuration file or the command line. See
[Which options apply when verifying](commands.md#which-options-apply-when-verifying).
The configuration file's values for those keys therefore matter when a baseline
is created with `scan`.

## Validation

The file is validated field by field when it is loaded.

- It must be a JSON object. Comments and trailing commas are not allowed.
- **Unknown keys are errors**, not warnings. A typo that silently disabled an
  exclusion would be a security problem rather than a cosmetic one.
- Every problem found is listed together in the error message; the command then
  exits with status 64.
- Each pattern in `exclude` is compiled during validation, so an invalid
  pattern is reported when the file is loaded.

## Keys

The recognised keys are `$schema` (accepted and ignored), `baseline`,
`exclude`, `followSymlinks`, `recordMetadata`, `oneFileSystem`,
`maxFileSizeBytes`, `maxDepth`, `concurrency`, `checkMetadata`, `checkMtime`,
`debounceMs` and `intervalSeconds`.

| Key                | Type                           | Default (`init`)           | Command-line option           |
| ------------------ | ------------------------------ | -------------------------- | ----------------------------- |
| `baseline`         | non-empty string               | `.integrity/baseline.json` | `-b, --baseline`              |
| `exclude`          | array of strings               | see below                  | `-e, --exclude`               |
| `followSymlinks`   | boolean                        | `false`                    | `--follow-symlinks`           |
| `recordMetadata`   | boolean                        | `true`                     | none                          |
| `oneFileSystem`    | boolean                        | `false`                    | `--one-file-system`           |
| `maxFileSizeBytes` | non-negative integer or `null` | `536870912` (512 MiB)      | `--max-file-size`             |
| `maxDepth`         | non-negative integer or `null` | `64`                       | `--max-depth`                 |
| `concurrency`      | non-negative integer           | `8`                        | `-j, --concurrency`           |
| `checkMetadata`    | boolean                        | `true`                     | `--metadata`, `--no-metadata` |
| `checkMtime`       | boolean                        | `false`                    | `--mtime`, `--no-mtime`       |
| `debounceMs`       | non-negative integer           | `250`                      | `--debounce`                  |
| `intervalSeconds`  | non-negative integer           | `300`                      | `--interval`                  |

The default `exclude` list is:

```json
[".integrity/", ".git/", "node_modules/", "*.log", "*.tmp"]
```

The output of `integrity init --print`, which is also the content of the file
that `integrity init` writes, is:

```json
{
  "baseline": ".integrity/baseline.json",
  "exclude": [".integrity/", ".git/", "node_modules/", "*.log", "*.tmp"],
  "followSymlinks": false,
  "recordMetadata": true,
  "oneFileSystem": false,
  "maxFileSizeBytes": 536870912,
  "maxDepth": 64,
  "concurrency": 8,
  "checkMetadata": true,
  "checkMtime": false,
  "debounceMs": 250,
  "intervalSeconds": 300
}
```

### Notes on individual keys

- **`baseline`**: path of the baseline file. A relative path is resolved
  against the scanned directory, not the current directory. Keeping the
  baseline outside the scanned tree, on storage the monitored workload cannot
  write to, is preferable. When it is inside the tree it is excluded
  automatically.
- **`exclude`**: glob patterns relative to the scan root. The syntax is
  described in [commands.md](commands.md#exclusion-patterns). Excluded paths
  are not protected: the matcher decides what is _not_ monitored, so review
  the list. The default list excludes `.integrity/`, `.git/`, `node_modules/`,
  `*.log` and `*.tmp` at any depth.
- **`followSymlinks`**: when `false`, symbolic links are recorded as entries
  whose hash covers the link target string. When `true`, they are followed and
  the target's contents are hashed (or the target directory is descended into,
  subject to cycle detection).
- **`recordMetadata`**: records `mode`, `uid` and `gid` for each entry in the
  baseline. It has no command-line option; set it in the configuration file
  before running `scan`. Permission and ownership comparison during
  verification requires the values to be present in the baseline.
- **`oneFileSystem`**: skips directories whose device differs from the root's.
  Skipped directories are recorded with the reason `other-filesystem`, which
  makes a later verification incomplete.
- **`maxFileSizeBytes`**: files larger than this are not hashed; they are
  recorded as skipped with the reason `too-large`. `null` removes the limit.
  On the command line the value is a size string such as `20M`; in the file it
  is an integer number of bytes.
- **`maxDepth`**: directories deeper than this below the root are not entered
  and are recorded as skipped with the reason `max-depth`. `null` removes the
  limit. The command-line option accepts 0 to 4096.
- **`concurrency`**: number of files hashed at the same time. The command-line
  option accepts 1 to 1024. Values in the file are only checked to be
  non-negative integers; the scanner treats a value below 1 as 1.
- **`checkMetadata`**: during verification, compares permissions and ownership
  in addition to contents.
- **`checkMtime`**: during verification, reports a modification-time
  difference on a file whose contents are identical.
- **`debounceMs`, `intervalSeconds`**: used by `watch` only. See
  [commands.md](commands.md#integrity-watch). The command-line options accept
  0 to 60000 and 0 to 86400 respectively; values in the file are only checked
  to be non-negative integers.

### Settings with no configuration key

`--max-pending`, `--once`, `--json`, `--output`, `--detailed`, `--summary`,
`--key-file`, `--key-id`, `--force`, `--stdout` and `--print` are command-line
only. Keys are supplied through `--key-file` or `$INTEGRITY_KEY`; a key can
never be stored in the configuration file.

## Example

A configuration for a web application that also ignores build output and stays
on one filesystem:

```json
{
  "baseline": "/var/lib/integrity/app.baseline.json",
  "exclude": [".git/", "node_modules/", "*.log", "/build/", "/tmp/**"],
  "oneFileSystem": true,
  "maxFileSizeBytes": 104857600,
  "intervalSeconds": 120
}
```

Keys that are omitted take the built-in defaults, which are the same as the
values `init` writes, with one distinction: when no configuration file exists,
or the file has no `exclude` key, the exclusion list is empty (apart from the
implicit baseline exclusion) rather than the default list shown above.
