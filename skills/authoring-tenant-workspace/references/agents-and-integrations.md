# Agents and integrations

Exact shapes: `Row<'sys_envoy'>`, `McpSpec` and `IntegrationSpec` from `@norbital-ai/bolt`. Read the contract skill's actual file list; there is no envoy source declaration or assumed envoy card.

## Briefs and skills

- `+agent.md` briefs staff; `+agent.external.md` briefs external members. A brief describes work and evidence, never authority. The agent acts as its identity through the same access points as a person.
- A workspace skill is `src/agent/skill/<name>/`: `+skill.md` (`description:` frontmatter, `##` sections), scripts and vendored pure-JavaScript packages, at most 10 MiB, no links.
- A script runs as written through `run_js { file }`: its tree is read-only at `/app`, files at `/in/<name>`, `/out` reaches the person. Only `fs`, `path`, `buffer`, `process`, `util` built-ins exist; `fetch` needs the `http` grant.
- Policies grant MCP servers and host tools through `capabilities`; every skill is open to every actor.
- A brief or skill handling documents says which part to read, never the whole file. A format with no parser is the workspace's to parse with a tool or integration. Record imports stay on syncs.
- Ask questions through the structured input tool and let its native card collect the answer. The user's workspace `page` tool exists only in a root web conversation. Envoys, automation inference and delegated agents have no user tab; use the separate fleet browser when available for research.

## Agent automations

- An agent tool is an ordinary `src/automation/+<name>.automation.ts` declaration. Set `agent: 'direct'`, `'confirm'` or `'never'`; the automation's required `policies` provide its authority.
- Use `mode: 'call'` for an immediate typed answer and the default job mode for durable work. Declare file inputs and use `ctx.files` for stored files. Helpers stay beside their owner.
- `workspace_install` adds exact dependencies to the working tree. Import pure JavaScript or WebAssembly packages into the automation; the compiler bundles them into the workspace's guest. Native addons, processes and dynamically downloaded code are unavailable.
- Start it through `ctx.run` or the agent's native automation control. There is no separate tool declaration, `run.ts` entry or `run_tool` call.

## Envoys

- An envoy is the workspace agent answering senders on a conversation instance. `sys_envoy` rows hold the tenant's name, audience, policies, task and group, delegation, triage and DM settings.
- Deployment is `sys_integration.envoy` on a workspace account (owner null), at most one envoy per account; `active: false` pauses it. Create and configure accounts at runtime. No source connection slot or release owns their identity. Pair through the native integration setup, where the person supplies credentials.
- Never seed envoys.
- `private` admits a sender whose handle matches a member (phone, email, telegram); others get one fixed notice per 15 minutes. Drivers with no member handle admit nobody. `public` admits anyone. Email is always addressed; group chat follows `group_messages`.
- An email sender links only when the receiving server vouches for the `From` domain (DMARC, or aligned DKIM); otherwise it is unknown. Say so before promising a private email envoy on a mail server outside Google and Microsoft: it needs the connection's Authentication server.
- A group turn or unlinked DM holds the envoy's `policies` alone, every requestor variable null except `{ var: 'requestor.instance' }`.
- A linked member's DM: `dm: 'union'` adds the member's own authority, admin included; `dm: 'envoy'` holds the envoy's policies with operands bound to the member, admin false, no member routes, tools or automations.
- Limits are always the envoy's. Envoys never decide approvals.
- `requestor.instance` is the arriving instance, or the instance of a remote sync run, null otherwise, so it fails closed. It types only against an FK to `sys_integration`.

## Integration definitions

- `integration(spec)` declares description, driver, typed configuration, credentials or OAuth, webhook verification, optional `rate`, inline `test`. Models own their syncs; definitions own no business projection.
- Built-in conversation definitions reserve whatsapp, email, telegram, slack, discord and wechat.
- `rate` paces every request. HTTP paths stay under the declared HTTPS base URL.
- SQL Server takes structured operations from `DatabaseRequester`; inspect that contract before constructing a request. The host bounds execution.
- Keep template-specific SQL, retention, assembly and business meaning in template source. Provider and platform code hold no domain rules.

## Instances

- An instance is one `sys_integration` row: integration, name, owner, envoy, active, configuration, host-written status. Configuration is decoded on every write.
- Create any number of accounts through native `sys_integration` grants. Pairing, pause, configuration and envoy deployment stay runtime; persisted account identities and sealed credentials let the host reopen their links after a restart.
- Credentials stay sealed host-side, never in configuration, seeds, status, browser data or guest contexts.
- A personal instance has an owner: it syncs, sends no conversation messages, deploys no envoy.
- Manage through `sys_integration` grants; pair, unpair, test and status authorize as update on that row. Use native Settings and Connections, never a template account model.
- `ctx.integration(instance)` gives Effect operations and a status Stream. Native `IntegrationCard` and `IntegrationSetup` share the setup flow; `+integration.svelte` uses the supplied controller only when setup truly differs.
- Automations call `ctx.request(instance, op)` and `ctx.send`. Resolve an active workspace account from runtime records and narrow its definition with `instance_id`; refuse missing or ambiguous routing. A send may queue before pairing, while a live request needs its connected account. Decode external answers once. A response editing a read row passes that selected row as `target`.
- One OAuth redirect per workspace, `<public URL>/hooks/oauth/callback`; state routes it. Tokens refresh host-side. A Google sign-in needs no tenant client; declare `oauth` only to use the workspace's own.
- A record's instance ref pins its definition with `where` and carries `InstanceId`.

## Channels

1. Native channels: whatsapp, email, telegram, slack, discord, wechat.
2. Through the system `chat` integration: Teams, Google Chat, Lark, WeCom, Webex, Mattermost, Messenger, Instagram, X, XChat, LINE, Zalo, QQ, Weixin, Twitch, SMS, iMessage, Dial, AgentPhone, Zernio, Novu, GitHub, GitLab, Linear, Notion, Liveblocks, Velt, Gmail and Resend. WhatsApp Cloud and Kapso sit under whatsapp.
3. `sys_integration.create { integration: 'chat', name, envoy }`, then the person pairs it, picking the platform and pasting its settings. Their senders match no member, so give these connections a public envoy.
4. A platform on neither list has no native channel. An `http` definition cannot host an envoy and a workspace cannot supply a provider. An integration may verify and retain webhooks for a model sync; committed records may trigger an effect or business job. This does not supply native channel conversations, sender identity or typing. Never declare an automation webhook trigger.

A platform's level decides what can be promised to a customer. Read it from the connection form or `integrations.md` before you say a channel stays in step:

1. `changes` and `history` repair missed messages. `webhook` repairs nothing past the platform's own retries.
2. A delete reaches Norbital only through a change log, a platform's delete event, or a complete `history` read.
3. A repaired message keeps file names and sizes, not content, and starts no envoy turn unless it is new and recent.

A daily programmatic message is a cron job calling `ctx.send` through the workspace account that deploys the envoy. It
creates the account's durable conversation, so recipient follow-up can reach that envoy after pairing. A never-paired or
disconnected account retains queued messages across host restart; its connected transition releases the queue without
using up provider attempts while waiting. Keep the returned message id. With an explicit `sys_message` output grant,
read native status, timeline and `sent_at` before projecting a report's external delivery state. Successful queue
admission or an in-app notification cannot mark WhatsApp Sent. Provider-id registration is correlation only. Queue
admission, provider acknowledgement and recipient reply are separate evidence; do not promise exactly-once sending
across a retried job or automatically retry a non-idempotent uncertain send.

## Proving a connection

1. A preview binds no links: `workspace_try` on a sync answers `unlinked`. `unconnected` means no connection record exists.
2. Prove decoding in a test with `t.fakes.links.answer`, then start the sync on live after the merge and read the rows.
3. `channel_check` answers a connection's state on live, sends a real test message with `test`, and on a host with the channel simulator connects with `pair` and writes as a customer with `customer`, through the whole pipeline.
