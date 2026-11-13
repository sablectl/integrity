---
name: Feature request
about: Suggest an improvement or a new capability
title: ''
labels: enhancement
assignees: ''
---

## Problem

What are you trying to do, and what makes it difficult or impossible today?

## Proposed change

What would you like Integrity to do? If it involves a new option, command,
output field or exit code, describe the intended behaviour as precisely as you
can.

## Alternatives considered

Other approaches you considered, including workarounds with the current
options.

## Effect on guarantees

Integrity is a security-relevant tool, and several behaviours are fixed on
purpose (see the design principles in CONTRIBUTING.md and docs/security-model.md).
Please say whether the proposal:

- could cause a run to be reported as clean when entries were not checked;
- could replace or modify a baseline implicitly;
- adds a runtime dependency;
- changes the baseline format, the JSON report or the exit codes.

## Additional context

Examples, links, or sample output that help explain the request.
