# Where a change lives

A setting's name does not say which side it belongs on: inspect the declaration and configuration model.

## Source (needs a merge)

| Change | Home |
| --- | --- |
| Fields, enums, constraints, indexes, refs, layers, transforms and effects | the model's `+model.ts` |
| Syncs | `+<sync>.sync.ts` beside it |
| A connection's driver, configuration shape, credentials shape, webhook verification and handler, rate, `test` | `src/integration/<name>/+integration.ts` |
| A value the built-in kinds cannot express | `src/data/custom_field/<name>/` |
| What a policy permits: outputs, apps, tools, MCP, limits | `src/access_control/policy/` |
| Team handles, policies and their hierarchy | `src/access_control/team/+team.ts` |
| Additional staff entitlements and level ordering | `memberships` in `src/+workspace.ts` names protected assignment models and the issuable teams |
| Approval routes and steps | `ctx.approve(...)` in a write grant's `verdict` |
| Screens | `src/app/<app>/` |
| Scheduled and manual business work | `src/automation/`; incoming webhooks belong to integrations |
| Agent briefs | `src/agent/+agent.md`, `+agent.external.md` |
| Workspace skills | `src/agent/skill/<name>/+skill.md` |
| Agent tools | `agent` on `src/automation/+<name>.automation.ts` |
| MCP servers | `src/agent/mcp/+<name>.mcp.ts` |
| Zone, locale, currency, app order and embedding model needs | `src/+workspace.ts` |
| Secret names | `src/+secrets.ts` |

## Runtime

| Change | Home |
| --- | --- |
| Member identity, primary affiliation and administrator status | guarded identity operations |
| Supplementary function grants and role bundles | protected rows on the declared membership models, issued by an Owner or a scoped automation |
| Connected accounts: pairing, sealed credentials, configuration, pause, envoy | `sys_integration` rows |
| Envoy name, audience, policies, DM authority, triage, task | `sys_envoy` rows |
| Allowed chat models and monthly AI budgets | administrator Settings → Organization (`sys_config`) |
| Supported formulas, rates, catalogue variants, extraction schema, report templates | business configuration models; source defines language and guards |
| Secret values | Settings, sealed per tenant |
| Personal display name, appearance and language | `read` the member's `sys_user` output `personal`, then `act` `sys_user.update` with its `id` and `revision`; no source change |
| Workspace display name | Administrators read `sys_workspace`, then `act` `sys_workspace.update`; private engine configuration stays inaccessible |
| Personal skills | Colony personal-skill tools, private per tenant and person, never release input |

Personal preferences persist on the user across devices. `preferences.appearance` is `light`, `dark` or `system`; `preferences.locale` is `en` or `zh`; `preferences.sounds` is a boolean. Merge existing preferences when changing one key. A member may edit their own name and preferences; sign-in addresses, administrator flags and team assignments use their guarded identity operations. Do not edit source or open a browser to change personal settings.

## Never

- A runtime editor for teams, policies or approval routes.
- A runtime table that creates team handles or assigns policies to them. Each team and its authority are declared in source.
- `.norbital/` is compiled output, never edited or committed.
- An administrator is a native flag on an admitted staff identity, not a role name.


## Verify delegated access

Sign in the member with `t.sign_in(address)` before checking the real read and write paths. For a supplemental grant, change the protected row through its normal workflow and obtain a fresh admission for the same identity. Check the denied state after removal and after the last inclusive day in the workspace timezone. `t.member(policies, overrides)` returns a test holder with the supplied policies; its first recognized team becomes the stored primary affiliation.
