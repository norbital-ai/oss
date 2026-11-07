# Agents and integrations

Exact shapes: `EnvoySpec`, `McpSpec`, `IntegrationSpec` from `@norbital-ai/bolt`.

## Briefs and skills

- `+agent.md` briefs staff; `+agent.external.md` briefs external members. A brief describes work and evidence, never authority. The agent acts as its identity through the same access points as a person.
- A workspace skill is `src/agent/skill/<name>/`: `+skill.md` (`description:` frontmatter, `##` sections), scripts and vendored pure-JavaScript packages, at most 10 MiB, no links.
- A script runs as written through `run_js { file }`: its tree is read-only at `/app`, files at `/in/<name>`, `/out` reaches the person. Only `fs`, `path`, `buffer`, `process`, `util` built-ins exist; `fetch` needs the `http` grant.
- Policies grant MCP servers and host tools through `capabilities`; every skill is open to every actor.
- A brief or skill handling documents says which part to read, never the whole file. A format with no parser is the workspace's to parse with a tool or integration. Record imports stay on syncs.

## Tools

- A tool is `src/agent/tool/<name>/`: `+tool.ts`, `tool({ description, input })`, data the compiler reads, and `run.ts`, whose default export is a `ToolRun`, `(input, files) => answer`. Helpers stay in the folder.
- `run_tool { name, input, files }` runs it on Node in a VM of its own: your working tree's for you, live's for everyone else. A merge tells every staff conversation of it, with its input, below what it holds. It reaches no records and needs no policy: pass what it needs and write what it finds with `act`.
- `workspace_install` brings a package. The network, a process, a worker, a native addon and any write but `files.write` are refused, so choose pure JavaScript or WebAssembly.
- `files.names` lists what the call handed it and `files.read(name)` gives its bytes. `files.write(name, content)` gives the person a file. Only the return value reaches you.
- Node strips the types: an import inside the folder names its file with `.ts`, and `enum` and parameter properties are refused.
- Run it on a real file with `run_tool` before you merge. A test imports `run.ts` and passes its own `files`.

## Envoys

- An envoy is the workspace agent answering senders on a conversation instance. `+<id>.envoy.ts` is a source default; `sys_envoy` rows hold the tenant's name, audience, policies, task and group, delegation, triage and DM settings.
- Deployment is `sys_integration.envoy` on a workspace instance (owner null), at most one envoy per instance; `active: false` pauses it. A connection's `envoy` is the default the release writes when creating the slot; a runtime change survives releases. `bolt check` refuses `envoy` on a connection with no conversation.
- Never seed envoys.
- `private` admits a sender whose handle matches a member (phone, email, telegram); others get one fixed notice per 15 minutes. Drivers with no member handle admit nobody. `public` admits anyone. Email is always addressed; group chat follows `groupMessages`.
- An email sender links only when the receiving server vouches for the `From` domain (DMARC, or aligned DKIM); otherwise it is unknown. Say so before promising a private email envoy on a mail server outside Google and Microsoft: it needs the connection's Authentication server.
- A group turn or unlinked DM holds the envoy's `policies` alone, every requestor variable null except `{ var: 'requestor.instance' }`.
- A linked member's DM: `dm: 'union'` adds the member's own authority, admin included; `dm: 'envoy'` holds the envoy's policies with operands bound to the member, admin false, no member routes, tools or automations.
- Limits are always the envoy's. Envoys never decide approvals.
- `requestor.instance` is the arriving instance, or the instance of a remote sync run, null otherwise, so it fails closed. It types only against an FK to `sys_integration`.

## Integration definitions

- `integration(name, spec)` declares description, driver, typed configuration, credentials or OAuth, webhook verification, optional `rate`, inline `test`. Models own their syncs; definitions own no business projection.
- Built-in conversation definitions reserve whatsapp, email, telegram, slack, discord and wechat.
- `rate` paces every request. HTTP paths stay under the declared HTTPS base URL.
- SQL Server takes structured operations: `read`, `call`, CDC pages, `insertOnce`. Discover them on the integration spec; the host bounds execution.
- Keep template-specific SQL, retention, assembly and business meaning in template source. Provider and platform code hold no domain rules.

## Instances

- An instance is one `sys_integration` row: integration, name, owner, envoy, active, configuration, host-written status. Configuration is decoded on every write.
- A `connections` slot creates its instance with the slot as id; unnamed instances go through ordinary grants. Pairing, pause, configuration and envoy deployment stay runtime.
- Credentials stay sealed host-side, never in configuration, seeds, status, browser data or guest contexts.
- A personal instance has an owner: it syncs, sends no conversation messages, deploys no envoy.
- Manage through `sys_integration` grants; pair, unpair, test and status authorize as update on that row. Use native Settings and Connections, never a template account model.
- `bolt.integration(instance)` gives typed Effect operations and a status Stream; `+integration.svelte` provides setup through the supplied controller, only when setup truly differs.
- Automations call `ctx.request(connectionOrInstance, op)` and `ctx.send`. Decode external answers once and keep typed failures. A response that edits a read row carries its observed revision.
- One OAuth redirect per workspace, `<public URL>/hooks/oauth/callback`; state routes it. Tokens refresh host-side. A Google sign-in needs no tenant client; declare `oauth` only to use the workspace's own.
- A record's instance ref pins its definition with `where` and carries `InstanceId`.

## Channels

1. Native channels: whatsapp, email, telegram, slack, discord, wechat.
2. Through the system `chat` integration: Teams, Google Chat, Lark, WeCom, Webex, Mattermost, Messenger, Instagram, X, XChat, LINE, Zalo, QQ, Weixin, Twitch, SMS, iMessage, Dial, AgentPhone, Zernio, Novu, GitHub, GitLab, Linear, Notion, Liveblocks, Velt, Gmail and Resend. WhatsApp Cloud and Kapso sit under whatsapp.
3. `sys_integration.create { integration: 'chat', name, envoy }`, then the person pairs it, picking the platform and pasting its settings. Their senders match no member, so give these connections a public envoy.
4. A platform on neither list has no channel. An `http` definition cannot host an envoy and a workspace cannot supply a provider. Say so. A webhook automation can answer it (`on: { webhook, verify }`, `ctx.ai`, `ctx.request`), and it lacks conversations, sender identity, typing and attachments.

A platform's level decides what can be promised to a customer. Read it from the connection form or `integrations.md` before you say a channel stays in step:

1. `changes` and `history` repair missed messages. `webhook` repairs nothing past the platform's own retries.
2. A delete reaches Norbital only through a change log, a platform's delete event, or a complete `history` read.
3. A repaired message keeps file names and sizes, not content, and starts no envoy turn unless it is new and recent.

## Proving a connection

1. A preview binds no links: `workspace_try` on a sync answers `unlinked`. `unconnected` means no connection record exists.
2. Prove decoding in a test with `t.fakes.links.answer`, then start the sync on live after the merge and read the rows.
3. `channel_check` answers a connection's state on live, sends a real test message with `test`, and on a host with the channel simulator connects with `pair` and writes as a customer with `customer`, through the whole pipeline.
