---
name: authoring-test-suites
description: Choose, write and review Bolt tests that fail for a named production defect.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# Authoring test suites

A test fails for a named production defect. Choose the smallest level that can observe the behaviour and assert its result. Call automated checks edge case tests.

## Protocol

1. Name the mechanism and the edit that would break it.
2. Pick the boundary: `references/coverage-rules.md`.
3. Discover the kit: `keyof typeof import('@norbital-ai/bolt-cli/test')`, then its types through `workspace_lang`. Do not read `node_modules` or copy a remembered harness.
4. Use small synthetic fixtures from the template's `seed/test/` or inline rows.
5. Include one valid operation and one relevant refusal; assert persisted state, and that a refusal left data unchanged.
6. Run through `workspace_test` or `bolt test`. Trust the exit code and the tested source.
7. Fix a failure's cause; never raise a timeout or weaken an assertion to reach green.

## Routing

| Task | Reference |
| --- | --- |
| What is and is not a test, boundaries, assertions, probes, deletion | `references/coverage-rules.md` |
| Kit, seed pack, syncs, envoys, inference, runners, clocks, migrations | `references/runners-and-harnesses.md` |
| Ports, layers, doubles, module seams, environment | `references/dependency-injection.md` |
| Reviewing an existing suite for false confidence | `references/false-confidence.md` |

## Limits

- One mechanism, once, in the package owning it. Templates do not retest Bolt; Bolt does not retest ui.
- A file costs about 2 s CPU; the realm about 60 s. A slow file is cut, never given a timeout.
- No sleeps, spawns, builds or network beyond loopback in a test.
- Probes are uncommitted scratch, deleted when done.
