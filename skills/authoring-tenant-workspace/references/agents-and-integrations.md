# Agents and integrations

Exact shapes: `Row<'sys_envoy'>`, `Parameters<typeof import('@norbital-ai/bolt').mcp>[0]`, `IntegrationLiteral`. There is no envoy source role.

## Briefs, skills & agent automations

- `+agent.md` (staff) and `+agent.external.md` (external): minimal end-user domain rules only — never authority, `[Catalogue]`, `KERNEL` or code rules (put code invariants in `src/agent/AGENTS.md`).
- Workspace skills (`src/agent/skill/<name>/+skill.md`, snake_case, `description:` frontmatter, ≤10 MiB pure JS/scripts, no symlinks) follow `skill-authoring`. Scripts run via `run_js { file }` (`/app` read-only, `/in/<name>`, `/out` attachments; built-ins `fs`, `path`, `buffer`, `process`, `util`; `fetch` needs `http` grant). Policies grant MCP/host tools; skills are readable by all.
- Agent tools are ordinary automations (`agent: 'confirm'` default; `'never'` hides from agent). Install pure JS/WASM deps via `workspace_install`.
- Delegated subagents (`task`) exclude approval-gated tools (`act`, `run`, `decide`, `invite`, `page`, `connect`, `download`, MCP, `run_js http: 'send'`, confirmed host tools). Parallel tool calls complete non-approval calls while pausing the turn for any emitted approval cards.

## Envoys

- Runtime `sys_envoy` rows (name, audience, policies, task, group/delegation/triage/DM settings) deployed via `sys_integration.envoy` on a workspace account (owner null; ≤1 envoy/account; `active: false` pauses; never seed envoys).
- `private` matches member handles (phone, email with DMARC/aligned DKIM, telegram, Slack/Discord `@<id>`; others get 1 notice/15m; drivers without handles admit nobody); `public` admits anyone.
- Authority: group turns and unlinked DMs hold envoy `policies` alone (`actor.*` null except `actor.instance`, typed to `sys_integration` FK). Linked member DM: `dm: 'union'` adds member policies/team tree (never admin); `dm: 'envoy'` (and every admin DM) holds envoy policies with member operands. Envoys have no confirmation cards (refuse confirmed actions) and never decide approvals; envoy limits apply.

## Integrations, instances & channels

- `integration('<name>', spec)`: `driver` (`http`, `sqlserver`, `email`, `chat`, `calendar` or host-registered custom), typed configuration/credentials/OAuth, `webhook` (`verify`, `handle` with `webhook.policies` keyed by delivery ID), `rate`, `test`. Built-in conversation names: `whatsapp`, `email`, `telegram`, `slack`, `discord`, `wechat`, `chat`. HTTP paths stay under declared HTTPS base URL; `http.lend: true` shares a workspace connection with members' host tools. SQL Server takes `DatabaseRequest`. Keep domain logic in template source.
- Runtime instances are `sys_integration` rows (credentials stay sealed host-side; personal instances have an owner and deploy no envoy; manage via native Settings/Connections, never a template account model). `ctx.integration(instance)` provides Effect ops/status; override `+integration.svelte` only when setup differs. OAuth shares `<public URL>/hooks/oauth/callback`.
- **Channels:** native (`whatsapp`, `email`, `telegram`, `slack`, `discord`, `wechat`) plus `chat` integration (Teams, Google Chat, Lark, WeCom, Webex, Mattermost, Messenger, Instagram, X, LINE, Zalo, QQ, Weixin, Twitch, SMS, iMessage, GitHub, GitLab, Linear, Notion, Gmail, Resend, etc. — use public envoy since senders don't match members). Other platforms have no native channel (use `http` webhooks + syncs, never automation webhook triggers). Only `changes`/`history` repair missed messages (`webhook` does not).
- **Daily sends:** cron job calling `ctx.send` on active paired workspace account (narrowed with `instance_id`); queued messages survive restarts until paired; derive delivery status from `sys_message` status/`sent_at`, never queue admission or in-app notices.
- **Proving:** preview has no live links (`workspace_try` returns `unlinked`); prove decoding with `t.fakes.links.answer`, then start sync on live after merge and use `channel_check` (`test`, `pair`, `customer`) on live/simulator.
