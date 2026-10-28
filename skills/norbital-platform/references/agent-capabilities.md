# Agent capabilities

## Read your tool list, do not assume it

Your capabilities are exactly the tools present in this conversation. They vary by subject because
the subject's effective policies own capability. A claim about what you can do is safe only after
looking at the offered tools.

The tool set is fixed by the platform:

| Tool                                                                 | Does                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`                                                               | Takes one read request, the same JSON layer map as `ctx.query` (roots, their declared layers, `where`, `fields`, `orderBy`, `limit`, `search`, `aggregate`, root `after`/`asOf`), under the subject's access points and policies                                                                                                                                                                                                 |
| `act`                                                                | Creates, updates, deletes or upserts through the model's standard guarded verbs, one callable per call with an array of rows — the same per-verb callbacks, policy checks and approvals as the app; `automation.<name>` starts an automation the subject may start; `approvals.decide` decides an approval                                                                                                                                                                                                            |
| `workspace_search`, `docs`                                           | Staff: the source (an ast-grep rule, a text, or a file by path; `draft: true` for their Studio draft), the platform API reference. On a host with a language tool, `workspace_lang` answers the checker (hover, definition, references, diagnostics, a type over Bolt's names)                                                                                                                                                   |
| `history`, `geocode`                                                 | Earlier conversations; places for an address or a point when the host has a geocoder                                                                                                                                                                                                                                                                                                                                             |
| skills                                                               | Reads a workspace skill (`src/agent/skill/+<name>.skill.md`) the subject's policies grant; the index sits in the system prompt                                                                                                                                                                                                                                                                                                   |
| `read_messages`, `read_attachment`, `read_output`                    | This chat's unaddressed messages on an envoy turn; a message's file as text, image or sheet; a long tool result                                                                                                                                                                                                                                                                                                                  |
| plan, goal and compaction tools; `subagent`, `wait` under delegation | Coordination                                                                                                                                                                                                                                                                                                                                                                                                                     |
| MCP tools                                                            | Tools of an MCP server (`src/agent/mcp/+<name>.mcp.ts`) a held policy's `capabilities.mcp` names                                                                                                                                                                                                                                                                                                                                 |
| host tools                                                           | Workspace Studio (`workspace_write`, `workspace_validate`, `workspace_review`, `workspace_diagnose`, `workspace_lang`), repository references (`reference`), the browser (`browser_navigate`, `browser_snapshot`, `browser_act`, `browser_evaluate`, `browser_screenshot`, `browser_download`), web search (`web_search`), personal skills — in-app turns of staff members only, when a policy's `capabilities.tools` names them |

The system prompt carries the workspace outline: every model with its fields, relations, read layers
and guarded write verbs, the apps and their pages, automations with their triggers, policies, and where each one's
source lives. The closing note of each step carries the time and whom the turn acts for.

The catalogue lists only what the subject may invoke, and every call runs as the subject, so a
refusal is the engine's answer, never the agent's judgement. Colony personal skills use a separate
store keyed by tenant and person: `list_personal_skills` returns names and descriptions;
`read_personal_skill` loads one body; `save_personal_skill` and `delete_personal_skill` manage only
the current user's. They never enter releases or grant permissions. Declaring a skill or an MCP
server does not grant it: policies name what their holders may use.

MCP is `2026-07-28` only. A granted registration authorizes discovery; the runtime uses the official
SDK's `server/discover` result as the offered names and schemas for that run. Never hard-code a
`<server>:<tool>` label, cache a remote schema as a local declaration, or negotiate a 2025/session
fallback. If the server returns an input request or an error, relay the actual request or failure;
do not invent an answer.

A workspace may bring its own web search: when a granted MCP server offers a tool named `web_search`,
the host's `web_search` is not offered and the agent uses the server's (`mcp__<server>__web_search`).
Only `web_search` yields; every other host name stays the host's.

## Where authority comes from

There is no agent-level capability list, no `denyTools`, and no "missing means all" fallback. The
in-app agent runs as the signed-in member, with the brief `src/agent/+agent.md`
(`+agent.external.md` for external members). An envoy turn holds the envoy's `policies`. In a
linked member's DM it also holds the member's own authority by default (`dm: 'union'`, admin
bypass included). With `dm: 'envoy'` the DM holds the envoy's policies alone: every requestor variable
is bound to the member, admin is false, no member routes, tools or automations join, and
`history`'s 'mine' covers only that instance (precedent: the hr-payroll payroll hotline,
`+payroll_hotline.envoy.ts` scoped by `entity.hotline`). Group and unlinked turns hold the envoy's policies
with every requestor variable null except `{ var: 'requestor.instance' }`, the integration instance the
message arrived on. Limits are always the envoy's, and a paused or redeployed instance makes an
in-flight turn or pending proposal stale. The agent has no authority of its own: every read and
write follows the identity the turn runs as, through the same access points and policies as a
person. Agent configuration only scopes which tools that identity may use; there are no
agent-only computations. Author code reaches models through an
automation's `ctx.ai.sys_2.infer` (the LLM) and `ctx.ai.sys_1.decide` (typed decisions), never
through an agent tool.

The interactive agent is either the in-app agent or one declared envoy. A public envoy keeps a separate sandbox **per conversation** (keyed
`subject#conversation`) — not per sender, because without that partition every sender on a public
surface shares one tree and a stranger's upload sits where the next stranger can read it. A
`private` envoy runs in the matched member's own personal sandbox, but its capability remains
the envoy's declared policy ceiling; it never becomes another user or a web session for somebody
else.

Sandbox coordination stays inside that boundary. A subagent cannot cross to a different person,
sender, group, or envoy by naming it.

## Writes are not privileged

`act` runs unelevated. It passes through the same grants, transform and approval routes as
the same person clicking in the app. A write that triggers approval comes back `pendingApproval`:
it is committed at once and held by its request, so other writers are refused until it finishes,
and rejection rolls it back. Say which source team handle the compiled approval names. Direct
permission commits, matching denied permission commits under a request, and unmatched denial
remains denied. A record under approval refuses the agent's write with `locked`; report who may
change it.

A permission failure is information about the subject's access. It is not evidence that the platform
lacks the feature.

## The manifest does not contain everything

The outline names things, not implementation bodies or live rows, and it names the whole workspace:
what this subject may use is what its tools offer and what a call answers. Read source
(`workspace_search`) for inline write callbacks, policy checks, syncs, automations, envoy roles and approval routes; use `read` for live data. Member affiliation, integration instance configuration/deployment and business catalogues are runtime data; teams, policy links
and inline approval configuration are source declarations. Inspect the relevant source and
live records before claiming what can be configured without a release.

## Honesty rules

- Never claim a read or write succeeded without its tool result.
- Report failures and missing capability directly.
- Do not invent an administrative UI or your own model/vendor identity.
- Treat current tool results and durable state as authoritative.

## Execution and checkpoints

When advertised, `sandbox_run` runs scripts and project tests in a disposable exact-commit
snapshot with the workspace's dependencies installed. Git, host credentials, network and tenant
databases are not exposed. Named attachments are in `/inputs`; files written to `/outputs` come back
as attachment descriptors. Other changes are discarded; use `workspace_write` to save source.
A save commits only. `workspace_validate` is the preview and the only build: it builds the open
change's head and serves it as the preview (compilation/lint/audit, not tests). A merge needs the
preview of the head it promotes. Planning allows source/web/skill reads and Plan edits only.

Compaction uses one two-column Markdown table with Goal, Progress, What we learned, and
What's left. The original transcript remains available; invalid or truncated summaries never
replace working context.
