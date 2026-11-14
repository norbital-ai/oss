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
| Teams and policy links | `src/access_control/team/+team.ts` |
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
| Member identities and affiliation | identity records |
| Connected accounts: pairing, sealed credentials, configuration, pause, envoy | `sys_integration` rows |
| Envoy name, audience, policies, DM authority, triage, task | `sys_envoy` rows |
| Allowed chat models and monthly AI budgets | administrator Settings → Organization (`sys_config`) |
| Supported formulas, rates, catalogue variants, extraction schema, report templates | business configuration models; source defines language and guards |
| Secret values | Settings, sealed per tenant |
| Personal skills | Colony personal-skill tools, private per tenant and person, never release input |

## Never

- A runtime editor for teams, policies or approval routes.
- `sys_team` is a read-only source projection; never author `sys_assignment`.
- `.norbital/` is compiled output, never edited or committed.
- An administrator is a native flag on an admitted staff identity, not a role name.
