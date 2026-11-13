# Technical debt

Known, non-critical items as of v1.0.0. Nothing here blocks the release, and
nothing here is hidden: an integrity tool that is vague about its own state
has no standing to report on anyone else's.

## Development dependency advisories

`npm audit` reports **7 moderate advisories**, all in the development
toolchain and none reachable from installed or released code:

| Package                                     | Severity | Reached through                        |
| ------------------------------------------- | -------- | -------------------------------------- |
| `minimatch`                                 | moderate | `@typescript-eslint/typescript-estree` |
| `@typescript-eslint/*`, `typescript-eslint` | moderate | the same chain                         |

Facts that matter for assessing the risk:

- The published package has **no runtime dependencies**. `npm audit
--omit=dev` reports zero vulnerabilities, and CI enforces that on every
  push at `--audit-level=low`.
- The advisory is a regular-expression denial of service. The only code that
  reaches it is the linter, running on this repository's own sources on a
  developer machine or in CI.
- `npm audit fix` does not resolve it. The remediation it proposes is
  `typescript-eslint@8.36.0`, which is _older_ than the `8.72.2` already
  installed, so applying it would be a downgrade rather than a fix.

Action: leave it. Revisit when the upstream chain publishes a release that
actually carries the patched `minimatch`.

## Platform coverage

The toolkit is written against Node's cross-platform filesystem API, converts
path separators, and falls back gracefully when recursive watching is
unavailable. It has only been **run and tested on Linux**. macOS and Windows
are unverified, and the README says so rather than implying support that has
not been demonstrated.

Action: verify on macOS and Windows runners before claiming support; this is
a matrix addition to CI plus whatever the results require.

## Watch mode coverage

Automated tests cover the initial verification, the event-driven check
against a real filesystem, JSON event output, and clean shutdown on SIGINT.
Not yet covered automatically:

- the `--max-pending` truncation path under a large write burst,
- the non-recursive watcher fallback,
- recovery after a watcher error.

These paths are implemented and reasoned about, but they are driven by
platform behaviour that is awkward to provoke deterministically. They are
documented here rather than described as verified.

## Interrupted watch exit code

A watch session interrupted with Ctrl-C exits `130` only when the last
verification was clean. If the last verification found changes, was
incomplete, or distrusted the baseline, that code (`1`, `2` or `3`) is
preserved instead, on the grounds that a finding outranks the manner of
exit. This is deliberate and documented, but it is worth revisiting if it
surprises people in practice.

## Unknown members in a signed baseline

Schema validation drops unrecognised JSON members before the signature is
checked. Such members are therefore ignored by the tool, but they are not
covered by the keyed integrity tag. No current field is affected; it is
recorded here because it constrains how the schema may be extended.
