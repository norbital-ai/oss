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
  package: "@norbital-ai/bolt"
---

# The Norbital platform

A Norbital workspace is a business application defined by tenant source and compiled by
Bolt into a running app with a Postgres database behind it. On Colony, that source is one Git
repository per tenant, and every user or agent profile authoring against it gets its own worktree on
its own `profile/…` branch rather than its own clone; Git objects sit underneath, but the tenant does
not push to Git `main`. Source declares the supported data shapes and behaviour. Runtime records
hold member identities, integration instances (`sys_integration`: pairing, configuration, pause
and which envoy answers on it) and business catalogues. Envoy roles, teams, policy links and
inline approval configuration belong in source. A setting's
name does not tell you which side it belongs on: inspect the actual declaration and configuration
model before proposing a source release or a runtime edit.

## Where each kind of change lives

| Change                                                                                                   | Lives in                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Add a field, change an enum's values, add a constraint or index                                          | `src/data/model/<name>/+model.ts`                                                                            |
| References between models, ownership, delete rules                                                       | `fields.<name>: { kind: 'ref', to, inverse?, owned?, onDelete? }` in that model                              |
| Read and write layers, per-verb write callbacks and `notify`                                             | the same `src/data/model/<name>/+model.ts` literal                                                           |
| An external connection: driver, configuration, credentials, webhook verification, rate and inline `test` | `src/integration/<name>/+integration.ts` (whatsapp, email, telegram, slack, discord and wechat are built in) |
| File imports/exports and remote data exchange                                                            | the model's inline `syncs.<name>` (`with: 'file'` or an integration name)                                    |
| A structured value the built-in kinds cannot express                                                     | `src/data/custom_field/<name>/+definition.ts`                                                                |
| What each policy permits; masks, apps, tools, MCP, skills, limits                                        | `src/access_control/policy/+<name>.policy.ts`                                                                |
| Source teams and their policy links                                                                      | `src/access_control/team/+team.ts`, exact handles mapped to policy lists or structured entries               |
| Approval routes and steps                                                                                | `ctx.approve(...)` in the relevant policy write grant's `check`                                              |
| Screens                                                                                                  | `src/app/<app>/+app.ts` and `+<page>.page.svelte`                                                            |
| Scheduled, event-triggered or webhook business work                                                      | `src/automation/+<name>.automation.ts`                                                                       |
| Connected accounts: pairing, sealed credentials, configuration (e.g. selected calendars), pause, envoy   | runtime `sys_integration` rows; credentials sealed per instance by the host                                  |
| Named instances source addresses (`ctx.send('mail', …)`, a notice's `via`) and their default envoy       | `src/+workspace.ts` `connections`                                                                            |
| The in-app agent's brief (staff / external members)                                                      | `src/agent/+agent.md`, `src/agent/+agent.external.md`                                                        |
| Envoy name, audience, policies, DM authority, triage and task                                            | runtime `sys_envoy` rows; `src/agent/envoy/+<id>.envoy.ts` is only a source default                          |
| Envoy deployment, pairing and pause                                                                      | runtime `sys_integration.envoy` / `active` on a workspace conversation instance                              |
| Supported formulas, rates, catalogue variants, extraction schema and report templates                    | runtime business configuration models; source defines their language and guards                         |
| Workspace skills (indexed in the system prompt, read via `read_skill`)                                   | `src/agent/skill/+<name>.skill.md`                                                                           |
| Remote MCP servers                                                                                       | `src/agent/mcp/+<name>.mcp.ts`                                                                               |
| Time zone, locale, currency, app order, AI model classes, connections                                    | `src/+workspace.ts`                                                                                          |
| Secret names (encrypted values are supplied at runtime)                                                  | `src/+secrets.ts`                                                                                            |
| Personal skills (private to tenant and person; never release input)                                      | Colony personal-skill tools                                                                                  |

Compiled output lands in `.norbital/` and is never hand-edited or committed. `bolt build` generates
editable SQL migrations under root `migrations/`; commit SQL, `snapshot.json`,
`migrations.lock.json` and the generated `physical.json` proof together. Hosts apply that verified
migration history with its physical definitions at every prefix. Colony stores personal
skills separately per tenant and person: use `list_personal_skills` and `read_personal_skill`.

Member identities and affiliation, application records, integration instances and business
catalogues are runtime data. Teams and policy links are compiled source declarations, and approval
routing is inline source: a write grant's `check` returns `ctx.allow()`, `ctx.deny(...)` or
`ctx.approve(...)`. Among a holder's policies any allow executes; otherwise the first approve
commits provisionally under an approval request; otherwise the first deny refuses. There is no runtime team/policy/route editor or runtime approval configuration.
Exact source team handles identify policy links and routing; labels are display only and parent
hierarchy scopes data without inheriting authority. `sys_team` is a read-only source projection
for native references, not mutable authority; do not author `sys_assignment` objects. A routed
write commits at once and its request locks the held records; approval keeps the change,
rejection rolls it back to the checkpoint (references/approvals-and-policies.md).
An administrator remains a native flag on an admitted staff identity, not an authored role name.

## Reference routing

Read the reference that matches the question. Do not answer from memory.

- **[Approvals and policies](references/approvals-and-policies.md)** — how permission grants work,
  source grants and inline approval routing, guarded mutation behaviour, approval statuses,
  why a record came back locked, who is allowed to approve.
- **[Records, history and audit](references/records-history-and-audit.md)** — the framework-owned
  columns on every row, revision history and guarded restore, approval rollback, the separate
  administrator audit store, and live browser reads.
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
- When you cannot do something, inspect its home before explaining the required change. A model
  enum, team or policy definition needs a source change; a supported business catalogue entry
  changes through an authorized runtime write. Do not invent a configuration screen or insist on a release for a
  value the application already configures in records.
- Do not guess which model or vendor you are. The operator chooses that per workspace.
