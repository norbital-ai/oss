---
name: bolt-feasibility
description: Decide per sub-function whether a business function is native, mediated, or not appropriate on Norbital.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# Bolt feasibility

A verdict applies to one sub-function, never a whole request.

| Verdict | Meaning | Promise |
| --- | --- | --- |
| native | built from Bolt primitives, no third party | buildable in the workspace |
| mediated | part belongs to a third party | Bolt builds its side; the integration is in the plan |
| not-appropriate | outside the platform contract | say what can run instead |

`certified` qualifies a native or mediated row: the workspace implements the process, but the output is valid only through a provider or regulator.

## Protocol

1. Restate the request in business terms, without platform vocabulary.
2. Split by verb (track, quote, approve, pay, dispatch, verify, file, report, chat). A sub-function is one person's job on one screen.
3. Classify each with the decision tree in `references/classification-rules.md`. One mediated or excluded row does not sink the others.
4. For each mediated row state: what Bolt does, what the third party does, where they meet (model sync, automation request, signed webhook, conversation send, MCP server, browser library), and what survives an outage.
5. Separate implementing a process from being certified to produce the output. Promise the workflow, computation, audit trail and handoff; never certified payroll, valid e-signature or approved filing.
6. Answer with one table: sub-function, verdict, how it is built, boundary. Then state exclusions, what would change a verdict (volumes, jurisdictions, an existing system) and evidence: a primitive or precedent. Say when a claim rests on the inventory alone.

## Routing

| Need | Reference |
| --- | --- |
| Decision tree, probe questions | `references/classification-rules.md` |
| What a workspace does natively | `references/capability-inventory.md` |
| What is not-appropriate, certification catalog | `references/limits-and-boundaries.md` |

Runtime behaviour: `norbital-platform`. A build plan: `bolt-requirements`.
