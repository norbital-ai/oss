# W5: porting the agent into Pod

The agent loop moves from Core into the OSS package. This file is the inventory the port runs from —
measured against `norbital/apps/core/src/lib/agent` rather than estimated, so the work can be planned
without re-reading Core.

**Status: not started.** Nothing in this document is implemented. It is written so the next session
can begin without re-deriving the shape.

## Why it is not a copy

9,691 lines across 30 files. Only about 15% of that is liftable as-is; the rest is bound to Core
subsystems Pod does not have and should not grow.

| Core dependency                   | What it provides to the agent         | Where it goes                                    |
| --------------------------------- | ------------------------------------- | ------------------------------------------------ |
| `$lib/system_db/*`                | `chat.schema`, `agent_channel.schema` | **rewritten** onto Pod tenant collections        |
| `$lib/tenant_workspace/sandbox/*` | the microsandbox session and mounts   | **stays in Core**, re-exposed as `HostAgentTool` |
| `$lib/workspace_studio/*`         | branch operations                     | **stays in Core**, reached as a host plugin      |
| `$lib/billing/*`                  | usage gating                          | **stays in Core**                                |
| `$lib/live_object/*`              | live streaming                        | superseded by Pod's own sync                     |
| `@durable-streams/*`              | the chat transport                    | **stays host-side**                              |

The storage rewrite is the bulk of the work. Core keeps agent state in a _system_ database shared
across tenants; Pod has no system database, so `chat.schema` and `agent_channel.schema` become tenant
collections, and every query in `store.server.ts`, `channel-history.server.ts`, and
`channel-manager.ts` is rewritten against the tenant `db` facility.

## Inventory

### Liftable — no Core imports (~1,444 lines, 13 files)

`tools/_vendor/opencode/edit.ts` (253) · `channels/telegram.ts` (338) · `channels/channel-message.ts`
(293) · `channels/channel-tools.ts` (117) · `subagent-summary.ts` (116) · `tool-result.ts` (53) ·
`client.ts` (52) · `chat-stream-identity.ts` (50) · `model.server.ts` (49) · `assistant-parts.ts`
(40) · `models.ts` (37) · `todo-schema.ts` (24) · `channels/agent-run-link.server.ts` (22)

These need one new dependency: `@tanstack/ai`.

**Do not land these on their own.** They are leaves — without the trunk below they are unreferenced
modules, which is dead code by the definition applied everywhere else in this package. Port them with
their consumers or not at all.

### Needs adaptation (~8,247 lines, 17 files)

| File                                  | Lines | Principal blocker                           |
| ------------------------------------- | ----- | ------------------------------------------- |
| `agent.server.ts`                     | 1114  | sandbox, billing, live objects, studio      |
| `channels/channel-history.server.ts`  | 957   | system DB                                   |
| `channels/whatsapp-baileys.ts`        | 923   | `@whiskeysockets/baileys` socket, `node:fs` |
| `tools/index.ts`                      | 897   | sandbox, browser service, system DB         |
| `store.server.ts`                     | 887   | system DB, live objects                     |
| `channels/channel-manager.ts`         | 705   | system DB                                   |
| `channels/index.ts`                   | 696   | Core auth and session                       |
| `tools/coding.tool.ts`                | 441   | sandbox — **stays in Core**                 |
| `agent_profile.ts`                    | 335   | Neon `Pool` held directly                   |
| `chat.remote.ts`                      | 334   | Core remote-function guard, durable streams |
| `tools/deployment.tool.ts`            | 197   | ops types — **stays in Core**               |
| `discovery.server.ts`                 | 171   | sandbox, MCP                                |
| `file-upload.svelte.ts`               | 163   | UI, straightforward                         |
| `channels/automation.ts`              | 140   | system DB, tenant runtime host              |
| `session_files.server.ts`             | 135   | worktree paths                              |
| `channels/pending-channel-message.ts` | 80    | system DB                                   |
| `streams.server.ts`                   | 72    | durable streams — **stays host-side**       |

Plus roughly 40 UI files under `routes/(workspace)/_components/agent/`, not inventoried here.

## Suggested order

1. **Tenant collections first.** Define the agent tables as Pod system collections and generate the
   migration. Nothing else can be ported until agent state has somewhere to live.
2. **`store.server.ts`** onto those collections. It is the seam every other server file goes through.
3. **The liftable leaves**, now that they have consumers.
4. **`agent.server.ts`**, with sandbox and studio calls replaced by `HostAgentTool` invocations.
5. **Channels**, with Telegram as the built-in transport and WhatsApp supplied by the host.
6. **UI**, last — it is the least coupled and the easiest to verify by eye.

## What already exists in Pod

`src/lib/server/agent/agent-loop.server.ts` and `src/lib/authoring/automations/agent-tools.ts`
(450 lines together). The loop there is a reduced implementation that agent automations already use;
step 4 replaces it rather than adding beside it. Its ad-hoc collection allowlist
(`agent-loop.server.ts`) is a placeholder for the policy-driven access the port should adopt.
