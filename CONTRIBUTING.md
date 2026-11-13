# Contributing

Thank you for considering a contribution to Integrity. This document describes
how to set up a working tree and what is expected of a change.

## Ground rules

- Integrity is a security-relevant tool. Correctness and honesty about what
  the tool can and cannot detect matter more than features.
- The tool has **zero runtime dependencies**. Please do not add any. Development
  dependencies are acceptable where they are justified.
- Documentation and behaviour must agree. A change that alters a flag, a
  default, an exit code or the baseline format must update the relevant
  document in `docs/` and `CHANGELOG.md` in the same pull request.
- Do not claim in documentation or comments anything the code does not do.
- Security vulnerabilities must not be reported through public issues. See
  [SECURITY.md](SECURITY.md).

## Development setup

Node.js 20.19 or later is required.

```sh
git clone https://github.com/sablectl/integrity.git
cd integrity
npm ci
npm run build
```

Run the built CLI with:

```sh
node dist/bin/integrity.js --help
```

## Checks

Each of these scripts is defined in `package.json`:

| Script                     | Purpose                                  |
| -------------------------- | ---------------------------------------- |
| `npm run check`            | Type-check without emitting output.      |
| `npm run lint`             | Run ESLint.                              |
| `npm run format:check`     | Verify Prettier formatting.              |
| `npm run format`           | Apply Prettier formatting.               |
| `npm test`                 | Run the unit tests.                      |
| `npm run test:integration` | Run the integration tests.               |
| `npm run build`            | Compile to `dist/`.                      |
| `npm run verify`           | Run all of the above checks in sequence. |

Please run `npm run verify` before opening a pull request.

## Making a change

1. Open an issue first for anything beyond a small fix, so the approach can be
   agreed before work begins.
2. Create a branch from `main`.
3. Keep the change focused. Unrelated clean-ups belong in separate pull
   requests.
4. Add or update tests for behaviour you change. Bug fixes should include a
   test that fails without the fix.
5. Follow the style of the surrounding code, including the explanatory comments
   that state why a decision was made. Formatting is enforced by Prettier and
   ESLint.
6. Update the documentation and add an entry under an `Unreleased` heading in
   `CHANGELOG.md`.
7. Open a pull request using the template and describe what changed and why.

## Design principles

These are the reasons several behaviours are fixed. Changes that weaken them
need a strong argument.

- A run is only clean if every entry was checked. Skipped or unreadable
  entries must never be silently dropped.
- Nothing rewrites the trusted baseline implicitly. There is no re-baseline
  from `verify`, and `scan` refuses to overwrite without `--force`.
- Unknown options and configuration keys are errors, not warnings.
- Baselines, configuration files and saved reports are untrusted input and are
  validated before use.
- Anything printed from the filesystem is escaped first.

## Reporting bugs and requesting features

Use the issue templates. For bugs, include the version (`integrity --version`),
your Node.js version, your operating system and filesystem, the exact command,
and the output.

## Licence

By contributing you agree that your contributions are licensed under the
[MIT licence](LICENSE).
