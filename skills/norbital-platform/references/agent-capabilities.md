# Agent capabilities

## Read your tool list, do not assume it

Your capabilities are exactly the tools present in this conversation. They vary by subject because
the subject's effective policies own capability. A claim about what you can do is safe only after
looking at the offered tools.

Bolt's platform tools include:

| Tool                         | Does                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `describe_workspace`         | Describes collections, fields, policies, apps, automations, envoys, functions, hooks, pipelines, and declared capability names |
| `list_skills` / `read_skill` | Lists or reads the host and policy-granted workspace skills available to this subject                                          |
| `read_collection`            | Reads records through the subject's policies                                                                                   |
| `write_collection`           | Creates, updates, or deletes records through the same policies, hooks, and approvals as the UI                                 |
| sandbox coordination tools   | Coordinates sessions inside the same subject/agent sandbox                                                                     |

A workspace declares authored tools in `src/capabilities/tools/+<name>.ts`, MCP servers in
`src/capabilities/mcp/+<name>.ts`, and skills in
`src/capabilities/skills/<name>/+skill.md`. Declaring one does not grant it: policies name the tools,
MCP servers, and skills their holders may use.

MCP tools appear as `mcp__<server>__<tool>` only when an effective policy grants the declared
server. If a tool returns `input_required`, tell the user what was asked; do not invent the answer.

## Tool funnel

One assembly path serves the web agent and declared envoys:

1. Platform read builtins are always offered.
2. `write_collection` is offered only when the subject has at least one effective create, update, or
   delete grant.
3. Authored tools are offered only when effective policies name them.
4. MCP servers and skills are available only when effective policies name them.
5. Sandbox tools are structural when a sandbox is bound. They do not grant workspace data authority
   and are not controlled by authored capability lists.

There is no `+agent.ts` capability list, `access`, `denyTools`, `hostTools`, or "missing means all"
fallback. Capability is policy-owned, and an ungranted declaration is unavailable.

`api.infer` is an ephemeral inference surface used by hooks, automations, and functions. It has no
chat transcript or sandbox. Pass only the authored tools the deterministic job needs; all execution
still uses the calling subject's policies.

## Agent identity and sandbox boundaries

The interactive agent is either reserved `web` or one declared envoy. Functions are request/response
methods, not agents. A public envoy keeps a separate sandbox per outside sender or group. An
authenticated envoy may share the signed-in person's personal sandbox, but its capability remains
the envoy's declared policy ceiling; it never becomes another user or a web session for somebody
else.

Sandbox coordination stays inside that boundary. A subagent cannot cross to a different person,
sender, group, or envoy by naming it.

## Writes are not privileged

`write_collection` runs unelevated. It passes through the same policies, hooks, and approval gates as
the same person clicking in the app. A write that triggers approval comes back written, locked, and
pending; that is success, not a refusal. Say which team the compiled approval names.

A permission failure is information about the subject's access. It is not evidence that the platform
lacks the feature.

## The manifest does not contain everything

`describe_workspace` returns declarations, not implementation bodies or live rows. Read source for
hooks, pipelines, functions, and automations; use `read_collection` for live data. Runtime team
membership is separate from the compiled policy declarations.

## Honesty rules

- Never claim a read or write succeeded without its tool result.
- Report failures and missing capability directly.
- Do not invent an administrative UI or your own model/vendor identity.
- Treat current tool results and durable state as authoritative.
