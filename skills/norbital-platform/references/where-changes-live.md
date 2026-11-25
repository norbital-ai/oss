# Where a change lives

Inspect the declaration and configuration model before deciding whether a change belongs in source or runtime.

## Source (requires merge)

| Change | Home |
| --- | --- |
| Models, fields, constraints, indexes, layers, transforms, effects | `src/data/model/<name>/+model.ts` |
| File/remote syncs | `+<sync>.sync.ts` beside model |
| Integration driver, config/credential schemas, webhooks, rate, `test` | `src/integration/<name>/+integration.ts` |
| Custom datatypes & renderers | `src/data/custom_field/<name>/` |
| Policies, teams, hierarchy, approval verdicts | `src/access_control/policy/`, `team/+team.ts` |
| Staff membership entitlements, zone, locale, languages, theme, limits, AI | `src/+workspace.ts` |
| Apps, pages, kiosks, automations, MCP, briefs, workspace skills, secrets | `src/app/`, `automation/`, `agent/`, `+secrets.ts` |

## Runtime (no release)

| Change | Home |
| --- | --- |
| Member identities, affiliation, admin flag, supplemental grants | guarded identity ops & declared membership models |
| Connected accounts (pairing, credentials, config, pause, envoy) | `sys_integration` rows |
| Envoys (name, audience, policies, DM/triage/task) | `sys_envoy` rows |
| Chat models, AI budgets, system agents (on/off, policies, spend limits), retention | Settings → Organization (`sys_config`) |
| Business catalogues, rates, formulas, extraction schemas, templates | validated runtime configuration models |
| Secret values | Settings (sealed store) |
| Personal settings & workspace display name | `sys_user` (`personal`) & `sys_workspace` — see `records` skill |
| Personal skills | `personal_skill` tool (private, never in releases) |

## Never & verification

- Never build runtime editors/tables for teams, policies or approval routes; never edit `.norbital/`; admin is a boolean flag on staff identity, not a role name.
- Verify delegated access with `t.sign_in(address)` (fresh admission after supplemental grant changes; test denied state after removal and past inclusive end date). `t.member(policies, overrides)` binds the first recognized team as primary affiliation.
