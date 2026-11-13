---
name: Bug report
about: Report incorrect behaviour, a crash, or output that disagrees with the documentation
title: ''
labels: bug
assignees: ''
---

<!--
Security vulnerabilities must not be reported here. If Integrity reports a
clean result when it should not, or reads or writes outside the paths it was
given, use the private reporting route described in SECURITY.md instead.
-->

## What happened

A clear description of the behaviour you observed.

## What you expected

What you expected to happen instead, and where in the documentation or help
text that expectation comes from, if applicable.

## Steps to reproduce

The exact commands, in order. Include a minimal directory layout if one is
needed.

```sh
integrity scan ./example
integrity verify ./example
```

## Output

The complete output and the exit status (`echo $?`). Remove anything sensitive,
such as private paths.

```text

```

## Environment

- Integrity version (`integrity --version`):
- Node.js version (`node --version`):
- Operating system and version:
- Filesystem type of the monitored directory (for example ext4, APFS, NFS):
- Installed by (`node dist/bin/integrity.js` or `npm link`):
- Baseline signed with a key (yes / no):
- Configuration file in use (yes / no; attach it if relevant):

## Additional context

Anything else that may help: whether the problem is reproducible, whether files
were changing during the run, symbolic links, permissions, very large files, or
unusual file names.
