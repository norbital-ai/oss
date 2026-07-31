# The agent port: what moved from Core into Pod

The agent loop now lives in the OSS package. This file records what moved, what deliberately did not,
and what is still owed — measured against `norbital/apps/core/src/lib/agent` rather than estimated.

**Status: the six planned steps are done.** The loop, its storage, its permissions, an interactive
surface, channel authoring, and a chat panel are all in Pod. What remains is listed under
[Still owed](#still-owed) and is smaller than what landed, but it is not nothing.

## What Pod now owns

| Step | What landed                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------- |
| 1    | `chat_session` / `chat_turn` / `chat_message` as system collections, migrated in all templates |
| 2    | The loop writes `AiMessage` verbatim; `agent_run_step` retired                                 |
| 3    | Transcripts scoped to their session's owner                                                    |
| 4    | `remotes/agentChat` — an interactive conversation is a run with no automation name             |
| 5    | `src/channels/+<name>.channel.ts`, with `policy` bound to the generated `PolicyName`           |
| 6    | `@norbital-ai/pod/client/agent` — a chat panel driven by the pod's own loop                    |

Two decisions shaped the rest:

**One transcript model.** An automation's agent run and a person talking to the agent produce the same
messages, so they share `chat_session`; `automation_run_id` marks which is which. The old
`agent_run_step` was a bespoke decomposition (`kind`/`role`/`content`/`tool_*`) rebuilt on read, so the
stored form and the in-memory form could disagree. Storing the message means replay is a read.

**The tenant database, not a system one.** Core keeps agent state in a system database shared across
tenants. Pod has none, so this was a rewrite rather than a copy — and it is why `organization_id`
disappeared: a pod database _is_ one tenant, so that column would be a constant on every row and a
filter every query had to remember.

## What deliberately stayed in Core

| Core subsystem                    | Why it stays                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `$lib/tenant_workspace/sandbox/*` | a sandbox is host infrastructure; re-expose as `HostAgentTool` |
| `$lib/workspace_studio/*`         | a host surface, reached as a host plugin                       |
| `$lib/billing/*`                  | Core owns the commercial relationship                          |
| `$lib/live_object/*`              | superseded by Pod's own sync                                   |
| `@durable-streams/*`              | a socket the tenant cannot hold open                           |

`tools/coding.tool.ts` and `tools/deployment.tool.ts` follow the sandbox and stay in Core. They reach
a tenant's agent through the seam below.

## `HostAgentTool`

A host tool is a facility whose _method set_ is discovered at runtime rather than fixed by its type.

That sentence is the whole design, and it is what made the seam look impossible for a while. Three
constraints were real: `agentTools` are workspace-declared and compiled into the guest bundle, so a
host tool is not in it; the host-command plane runs host→guest only; and `RuntimeFacilityBindings`
cross the isolate by structured clone and cannot carry callbacks, which is why `HostQueue` and
`HostIntegrationDelivery` live on the host config instead.

What the third constraint actually forbids is a binding that _is_ a map of host functions. It does not
forbid guest→host calls: `facilityProxy` in `runtime/serve.ts` already answers every property get with
a call forwarder, which is exactly how `db` and `fileStorage` are called from inside the isolate. So
the binding is fixed at two methods and the tools are data:

```ts
export type HostAgentToolBinding = {
	list(): Promise<readonly HostAgentToolSpec[]>; // { name, description, inputSchema }
	run(name: string, input: unknown): Promise<unknown>;
};
```

`list()` is a call and not a field for the same reason `listChannels()` is. The host writes tools as
data on its config, and `pod start` assembles the binding:

```ts
// pod.host.ts
export default definePodHost({
	mode: 'self-hosted',
	// ...
	agentTools: [
		{
			name: 'deploy_workspace',
			description: 'Build and deploy this workspace from the host sandbox.',
			input: z.object({ target: z.enum(['staging', 'production']) }),
			run: async (input) => sandbox.deploy(input.target)
		}
	]
});
```

```ts
// src/automation/+nightly_deploy.ts — the opt-in, and the whole of it
export default defineAutomation(
	{ schedule: '0 3 * * *' },
	{ kind: 'agent', task: 'Deploy staging.', hostTools: ['deploy_workspace'] }
);
```

**Permissions: default deny, workspace opt-in, no convenience path.** A host tool runs in the host
process with the host's credentials, so registering one exposes it to nothing. An agent sees a host
tool only if its own spec names it in `hostTools` — the same narrowing `tools` already applies to
workspace tools, in workspace source, where it appears in a diff. Deliberately absent: any "offer
every host tool" shortcut. `agentChat` grants a chat every _workspace_ tool on the reasoning that an
authored tool is a surface the workspace already decided to expose; that reasoning does not transfer
to a tool the workspace did not write, so an interactive chat reaches no host tool at all.

Also absent: a caller. `run(name, input)` carries no identity, because a tenant isolate's claim about
who is asking is not something the host can verify. A host tool authorizes against what the host
already knows — which tenant this container is — and never against an assertion that arrived over the
binding wire.

**Collisions are a startup error.** The model is offered one flat list, so a host tool named
`create_quote` beside a workspace tool named `create_quote` produces a call that names one thing and
could mean two. `assertHostAgentTools(config.agentTools, manifest)` runs before `pod start` listens
and refuses both directions: a host tool shadowing a workspace tool or a built-in, and an agent naming
a host tool this host does not supply. The manifest now carries workspace agent-tool names (name and
description only) so a host can see the namespace it is joining; agent specs carry `hostTools` so the
host can check the other way. `requiredRuntimeFacilities` treats `agentTools` as static, so a
workspace whose agent names a host tool refuses to start on a host that supplies none. The loop
repeats the shadow check when it resolves a run's tools, because Core is a host this package does not
run — a collision that slips past a host's startup still fails before any model call rather than
resolving to whichever dispatch branch is reached first.

Proven by `tests/standalone/host-agent-tool-e2e.test.ts` (a real `pod start`, a real `pod.host.ts`,
an agent run whose result reaches `chat_message`) and `tests/runtime/host-agent-tool.test.ts` (the
same binding through the real `facilityProxy` and a structured clone — the Core path).

## Still owed

**Channel delivery — the thin path exists; the rest of Core's runtime does not.** A declared channel
now routes: inbound → agent under the declared policy → reply over `messaging.sendVia`, on two tenant
collections (`channel_conversation`, `channel_inbound_message`) and a host-driven inbound seam
(`SelfHostedPodHostConfig.channels`). Telegram is built in over long polling; WhatsApp is
host-supplied. What Core has and this does not: the provider-history archive and its media pipeline,
external-sender-to-user linking with the pending-message hold, attachments, inbound batching, session
commands, and group semantics. See B3 in [CORE_REFACTOR.md](./CORE_REFACTOR.md) for the full list.

**The rest of the agent UI.** Core has roughly 40 components carrying streaming, subagent trees, todo
panels, and file upload. They depend on `@durable-streams` and `@tanstack/ai`; the panel here is a
working chat surface, not a replacement for them.

**Nothing further on the collection allowlist.** An earlier note here called it an ad-hoc placeholder
needing policy-driven replacement; reading it again, that overstated the problem. `read_collection`
calls `findMany` without `isElevated`, so the permission guard already applies and policy is the
enforcement. `spec.collections` narrows further on top of that — a declared scope, not a substitute
for one. It is a correct belt-and-braces, so it stays.

## A note on verification

Steps 1–5 are covered end to end against real Postgres — `agent-transcript-e2e` and `agent-chat-e2e`
prove transcript shape, sequence continuity, replay across turns, and cross-user rejection.

Step 6 is not. There is no component test infrastructure in this package — no jsdom, no browser runner
— so the panel is covered by `svelte-check` and by its one data dependency being proven end to end.
Rendering is unverified, and that gap is worth closing before anyone relies on it.
