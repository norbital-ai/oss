---
name: norbital-platform
description: >-
  How the Norbital platform itself behaves at runtime: approvals, policies and permissions, record
  history, audit, system columns, and what a workspace agent can and cannot do. Load before
  answering any question about how Norbital works, why a write was blocked or locked, who can
  approve something, where a configuration change lives, or what a framework-owned column means.
  This platform is not in any model's training data, so answering from memory produces
  confident wrong answers.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# The Norbital platform

A Norbital workspace is a business application defined by tenant source and compiled by
Bolt into a running app with a Postgres database behind it. On Colony, that source is one Git
repository per tenant, and every user or agent profile authoring against it gets its own worktree on
its own `profile/…` branch rather than its own clone; Git objects sit underneath, but the tenant does
not push to Git `main`. Almost everything a user might call "settings" — fields, dropdown values,
permissions, approval routing — is source code, not runtime configuration.

That single fact answers most questions people ask, and getting it wrong is the most common failure
mode: an agent invents an admin console that does not exist, and the user goes looking for it.

## Where each kind of change lives

| Change                                                          | Lives in                                   |
| --------------------------------------------------------------- | ------------------------------------------ |
| Add a field, change an enum's allowed values, add an index      | `src/collections/<name>/+model.ts`         |
| Business logic around a write                                   | `src/collections/<name>/+hooks.ts`         |
| Import and export shaping                                       | `src/collections/<name>/+pipelines.ts`     |
| Who may read/write; approvals, apps, tools, MCP, skills, limits | `src/access/policies/+<name>.ts`           |
| Which policies a team holds                                     | `src/access/+teams.ts`                     |
| Screens                                                         | `src/apps/`                                |
| Scheduled or event-triggered work                               | `src/automations/+<name>.ts`               |
| Extra tools                                                     | `src/capabilities/tools/+<name>.ts`        |
| Extra skills                                                    | `src/capabilities/skills/<name>/+skill.md` |
| Remote MCP servers                                              | `src/capabilities/mcp/+<name>.ts`          |
| Shared web/envoy prompt                                         | `src/+agents.md`                           |
| Reachable transport agents                                      | `src/envoys/+<name>.ts`                    |
| Query/command functions                                         | `src/functions/+<name>.ts`                 |

Compiled output lands in `.norbital/` and is never hand-edited.

Runtime data — users, teams, team membership, records — lives in the database and is edited in the
app. The line between the two matters, and it runs straight through the middle of "teams": _which
teams exist and who is on them_ is data an operator edits without a deploy, but _what a team may do_
and _which team approves step two of the payroll flow_ are both source. A person belongs to exactly
one team; there are no roles. A person's effective policies are the union declared by their team
and its descendants. Static envoys and automations name policy arrays directly and are never rows
in `user`.

## Reference routing

Read the reference that matches the question. Do not answer from memory.

- **[Approvals and policies](references/approvals-and-policies.md)** — how permission grants work,
  how an approval flow is declared and routed, write-then-lock behaviour, approval statuses, why a
  record came back locked, who is allowed to approve.
- **[Records, history and audit](references/records-history-and-audit.md)** — the framework-owned
  columns on every row, temporal history, rollback, audit, and how the client replica syncs.
- **[Agent capabilities](references/agent-capabilities.md)** — what a workspace agent can do, how
  its tool surface is decided, and the honesty rules that apply when a tool fails.

For authoring guidance — how to actually write the source files above — use the
`authoring-tenant-workspace` skill instead. This skill describes behaviour; that one describes
how to build against it.

## Answering well

Ground every claim in something you read this turn. In particular:

- Read the workspace manifest before describing its schema. Enum values, relationships and policies
  are all in it, and two fields that look like the same concept can carry different value lists.
- Read records before stating a count, a total or a status.
- When you cannot do something, say what would make it possible and where that change lives. "Ask
  your administrator" is almost always the wrong answer; "this is an enum in `+model.ts`, so it
  needs a source change and a deploy" is almost always the right one.
- Do not guess which model or vendor you are. The operator chooses that per workspace.
