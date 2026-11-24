---
name: authoring-tenant-workspace
description: Index of Bolt authoring references - models, access, apps, themes, automations, integrations, UI, build.
---

# Authoring index

Start with `bolt-primer`. Read one file under `references/` only when the task needs it. Exact API: `workspace_lang`.

| Task                                                            | File                                    |
| --------------------------------------------------------------- | --------------------------------------- |
| Entity boundaries, inline values, runtime configuration         | `model-boundaries.md`                   |
| Field kinds, relations, layers, locks, callbacks, search, syncs | `models-and-modeling.md`                |
| Dates, instants, periods, zones                                 | `dates-and-time.md`                     |
| Reads, atomic act maps, revisions, aggregates                   | `data-access.md`                        |
| Workspace, secrets, apps, SSR, kiosks, anonymous users          | `apps-and-surfaces.md`                  |
| Theme, accent, light/dark palette, fonts and radius             | `apps-and-surfaces.md`, Workspace theme |
| Automations, effects, notifications (`ctx.notify`), reruns, AI  | `automations-and-effects.md`            |
| Briefs, workspace skills, envoys, integrations, sync boundary   | `agents-and-integrations.md`            |
| What the platform renders                                       | `built-ins.md`                          |
| Primitive roles (`⚡`, matrix, timeline), page slots, toolbar, tabs, forms | `app-structure.md`                      |
| Composing novel interactive UIs (`Surface`, `@norbital-ai/ui/behaviors`)   | `behaviors-and-composition.md`          |
| UI review checklist                                             | `ui-standard.md`                        |
| Layout axioms                                                   | `interface-ideology.md`                 |
| Composition, sizing, scroll ownership                           | `layout-and-scrolling.md`               |
| Padding, gaps, the app inset                                    | `padding-and-spacing.md`                |
| Text roles, colour                                              | `typography.md`                         |
| Entity scope, relation display, one home per model              | `controller-surfaces.md`                |
| `bolt` verbs, generated files, seeds, migrations                | `generated-and-build.md`                |
| Hosts, facilities, needs                                        | `hosts-and-facilities.md`               |
| Message catalogs, raw-text rule                                 | `internationalization.md`               |
| Template manifest, README, thumbnail                            | `template-repository.md`                |
| Studio commits, migrations, history, merges, reverts, rollbacks | `studio.md`                             |
| Rebuild an existing application                                 | `repository-rebuild.md`                 |

Policies, teams, limits, approvals: `norbital-platform`, `references/approvals-and-policies.md`. Integration sync boundary & audit: `integration-sync`. Tests: `authoring-test-suites`.

## Author and verify

1. State tasks, actors, invariants and observable outcomes.
2. Inspect contracts and existing code. Decide entity boundaries before pages.
3. Reuse native controls whose contract fits; author only domain behaviour.
4. Validate, then exercise the real user path: resulting records, denied roles, empty, loading and error states.
5. Report implemented, verified and remaining work apart. Request merge only with evidence for the current head.

## Limits

- A compatible type does not prove runtime authority. A green build is not a test run.
- On a failed probe, use its diagnostic or narrow it; never cast or guess.
- A generated name appears after the next check.
- Adjacent acts are separate commits. Writes that commit together go in one act map, in dependency order; a later entry names an earlier created row by an id minted with `new_id(model)`. Parent/child writes go in nested layers.
- Decode unknown data at its boundary; keep typed failures.
- Keep customer data out of tests and evidence.
