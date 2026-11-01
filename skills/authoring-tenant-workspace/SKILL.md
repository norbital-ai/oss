---
name: authoring-tenant-workspace
description: >-
  Author Bolt tenant workspaces. Load for models, ref fields, policies,
  source teams, apps and pages, automations, integration definitions and model syncs,
  integration connections, envoys, custom fields, seeds, `$bolt`, `@norbital-ai/ui`, template
  metadata, or the `src/` file layout.
---

# Authoring Bolt Tenant Workspaces

A workspace is a directory whose `src/` holds `+` files. Each `+` file is a **compiler role**: it
exports its declaration or supplied UI according to that role.
Names come from paths, never from file contents. Everything without a `+` is an ordinary module.
`bolt build` turns the tree into a portable artifact. Colony hosts it by default (tethered, nothing to configure); an
untethered host supplies every facility itself. See [hosts-and-facilities.md](references/hosts-and-facilities.md).

## Mental model

Start with the model people work on: its fields, relations, read and write layers,
search, syncs, notices and business automations. A model is the entity and its exposed
contract; a representation presents one record through the shared controller. Add a page only
when it supports a distinct task beyond the model's normal view.

Prefer fewer entities. Parent-owned structured values belong in typed JSON or a custom datatype
unless identity, lifecycle, permissions, history or relational querying justify another model.
Configurable business choices belong in authorized runtime records; source defines the validated
language and the execution contract. Use Bolt's grants, approvals, state locks, relationships,
guarded write verbs, views and integration lifecycle rather than rebuilding them in template code.

## Discover contracts before implementing

Use the workspace's installed declarations as the authority for its version. `workspace_lang` is the contract
discovery tool: completions on an import enumerate exports without knowing their names; hover and checked types show
the compiler's signature, JSDoc, examples and deprecation guidance; definition and references locate the owning source.
Follow completion pages or narrow the prefix rather than assuming the first page is complete. Use an unsaved probe
buffer when discovery does not require a source edit. There is no separate docs tool.

Resolve uncertain input/output shapes with a checked type expression. Inspect declaration documentation for authority,
execution, defaults and failure behavior; a compatible type does not prove runtime permission or feature availability.
After changing declarations, refresh generated names through the normal check before trusting workspace-specific types.
If a probe fails, use its compiler diagnostic or narrow it; do not replace an unresolved contract with a cast or a guess.
Use the retrieved native capability wherever it meets the requirement, and author only the remaining domain behavior.

## Reference routing

| Task                                                                                                    | Reference                                                       |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Deciding entity boundaries, inline values and runtime-configured business behaviour**                 | [model-boundaries.md](references/model-boundaries.md)           |
| Field kinds, ref fields, layer maps, write callbacks, search and syncs                                  | [models-and-modeling.md](references/models-and-modeling.md)     |
| Dates, instants, periods, the workspace zone, date filters                                              | [dates-and-time.md](references/dates-and-time.md)               |
| Reads: `bolt.query`, read requests, live and once, paging, `src/lib` helpers, no N+1                    | [data-access.md](references/data-access.md)                     |
| Apps, pages, groups, automations, policies, agents, integration definitions and runtime instances       | [apps-and-server-roles.md](references/apps-and-server-roles.md) |
| **What the platform already renders** — the page shape, toolbar, search, record sheet: never rebuild    | [built-ins.md](references/built-ins.md)                         |
| **Where things go on a page** — header, actions, tabs, forms (readonly vs disabled), inner scroll       | [app-structure.md](references/app-structure.md)                 |
| Template UI review: disclosure, alignment, useful charts, one-accent/hairline rules and shared controls | [ui-standard.md](references/ui-standard.md)                     |
| Why the layout system is shaped this way                                                                | [interface-ideology.md](references/interface-ideology.md)       |
| Composition, scrolling, scroll traps                                                                    | [layout-and-scrolling.md](references/layout-and-scrolling.md)   |
| Controller UI: inline, `$derived`, no UUIDs                                                             | [controller-surfaces.md](references/controller-surfaces.md)     |
| Padding, gaps, the app inset                                                                            | [padding-and-spacing.md](references/padding-and-spacing.md)     |
| Headings, labels, captions                                                                              | [typography.md](references/typography.md)                       |
| `bolt` verbs, `.norbital/`, schema changes                                                              | [generated-and-build.md](references/generated-and-build.md)     |
| Tethered vs untethered, facilities, needs, `norbital.host.ts`, `bolt dev --host`                        | [hosts-and-facilities.md](references/hosts-and-facilities.md)   |
| Message catalogs, locales, the raw-text rule                                                            | [internationalization.md](references/internationalization.md)   |
| Template manifest, README, marketing thumbnail                                                          | [template-repository.md](references/template-repository.md)     |
| Authoring in Studio: changes, previews, merges, rollbacks, checks                                       | [studio.md](references/studio.md)                               |
| Rebuilding an existing application from a repository or source snapshot: coverage and native reuse      | [repository-rebuild.md](references/repository-rebuild.md)       |

Read only the relevant reference. Policy and approval behaviour is in the `norbital-platform` skill;
tests are in `authoring-test-suites`.

## Author and verify

1. Establish the requested tasks, actors, data invariants and observable outcomes. For a rebuild, read
   [repository-rebuild.md](references/repository-rebuild.md) and keep a requirement-to-evidence ledger.
2. Inspect the relevant installed contracts and existing workspace code. Start with models, outputs, guarded writes
   and authority. Choose entity boundaries before pages; source defines execution rules and runtime records hold
   authorized business configuration.
3. Reuse native controllers, forms, navigation, approvals and integration setup when their current contracts fit.
   Read [built-ins.md](references/built-ins.md) before adding a surface and the relevant layout reference when composing it.
   Keep one padding owner and one scroll owner per axis; inspect normal and narrow layouts.
4. Make a coherent edit, then run the normal compiler/type check. Run meaningful focused tests through the available
   test runner and inspect its parsed result and tested revision. A build, a written test or a valid type is not test execution.
5. Exercise the actual user path and verify its resulting records, denied roles, loading/error/empty states and recovery
   where relevant. Report implemented, verified and remaining work separately. Request publication only with evidence
   matching the current change; verify the resulting live routes after approval.

Use the tools provided by the host for source edits, checks, tests, preview and publication. A hosted agent has no
shell or Git runner. Independent API calls do not become atomic by being adjacent: discover the native transaction or
batch contract when one decision must commit together. Keep generated files under compiler ownership. Preserve native
Effect types and error channels, and decode unknown external data at its boundary rather than erasing types.

Credentials belong in native sealed setup controls, never source, chat or ordinary model fields. Reuse the system's
capability-to-UI mapping for configuration and user follow-up; distinguish an unpaired configuration from a completed
connection. Keep customer and private seed data out of tests and public evidence. Use small synthetic fixtures for
behavioral tests and follow the active host's approval boundary for system mutations.
