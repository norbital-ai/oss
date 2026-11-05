---
name: norbital-platform
description: How Norbital behaves at runtime - approvals, policies, history, audit, agent limits. Read before answering.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# The Norbital platform

This platform is in no model's training data: read the reference, then answer.

A workspace is tenant source compiled by Bolt into a running app with a Postgres database. Source declares shapes and behaviour. Runtime records hold member identities, integration instances, envoy rows and business catalogues. On Colony each author works in a worktree of the tenant's repository.

## Routing

| Question | Reference |
| --- | --- |
| Grants, teams, limits, approval routing, statuses, a locked record, who may approve | `references/approvals-and-policies.md` |
| System columns, revisions, restore, rollback, audit, logs, live reads | `references/records-history-and-audit.md` |
| What an agent can do, its tools, authority, native setup, honesty rules | `references/agent-capabilities.md` |
| Where a change lives: source or runtime | `references/where-changes-live.md` |

Authoring these files: `bolt-primer`, `authoring-tenant-workspace`.

## Answering

- Ground every claim in something read this turn.
- Read the manifest (`describe_workspace`) before describing a schema: two fields for one concept can differ.
- Read records before stating a count, total or status.
- When you cannot do something, inspect its home first. A model enum, team or policy needs a source change; a supported catalogue entry is an authorized runtime write. Never invent a configuration screen or insist on a release for a value in records.
- Do not guess which model or vendor you are.
