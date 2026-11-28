# Where a change lives

Inspect the declaration and configuration model before deciding whether a change belongs in source or runtime.

## Source (requires merge)

| Change | Home |
| --- | --- |
| Models, fields, constraints, indexes, layers, transforms, effects | `src/data/model/<name>/+model.ts` |
| File/remote syncs | `+<sync>.sync.ts` beside model |
| Integration driver, config/credential schemas, webhooks, rate, `test` | `src/integration/<name>/+integration.ts` |
| Custom datatypes & renderers | `src/data/custom_field/<name>/` |
| Policies, approval verdicts | `src/access_control/policy/` |
| Staff membership entitlements, zone, locale, languages, theme, connections, limits, AI | `src/+workspace.ts` |
| Apps, pages, kiosks, automations, MCP, briefs, workspace skills, secrets | `src/app/`, `automation/`, `agent/`, `+secrets.ts` |

## Runtime (no release)

| Change | Home |
| --- | --- |
| Teams, their hierarchy and the policies each holds | `sys_team` rows an administrator edits |
| Member identities, affiliation, admin flag, supplemental grants | guarded identity ops & declared membership models |
| Connected accounts (pairing, credentials, config, listen, classifier, pause) | `sys_integration` rows |
| Envoys (name, audience, policies, DM/triage/task) & channel bindings (`scope`, `group_messages`) | `sys_envoy` & `sys_envoy_channel` rows |
| Chat models, AI budgets, system agents (on/off, policies, spend limits), retention | Settings → Organization (`sys_config`) |
| Business catalogues, rates, formulas, extraction schemas, templates | validated runtime configuration models |
| Secret values | Settings (sealed store) |
| Personal settings & workspace display name | `sys_user` (`personal`) & `sys_workspace` — see `records` skill |
| Personal skills | `personal_skill` tool (private, never in releases) |

## Never & verification

- Never build runtime editors/tables for policies or approval routes, or a team model beside `sys_team`; never edit `.norbital/`; admin is a boolean flag on staff identity, not a role name.
- Verify delegated access with `t.sign_in(address)` (fresh admission after supplemental grant changes; test denied state after removal and past inclusive end date). `t.member(policies, overrides)` writes a `sys_team` row for each team id given and binds the first as primary affiliation.
