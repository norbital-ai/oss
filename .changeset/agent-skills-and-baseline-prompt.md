---
'@norbital-ai/platform-utils': minor
'@norbital-ai/pod': minor
---

Give the workspace agent a system prompt and a skill library, and let a workspace ship skills of its
own.

An interactive conversation in a workspace without `src/+agent.ts` ran with no system prompt at all.
Nothing told the model what platform it was on, so it filled the gap: it named a vendor and a model
version it had no way to know, described an administrative console that does not exist, and — having
found `norbital_approval_id` on every row but no readable `approvals` collection — concluded Norbital
has no approval system. Each of those reads to a user as a product limitation rather than as a
guess, which is the part that makes it expensive.

`AGENT_BASELINE_SYSTEM_PROMPT` is now composed ahead of any authored `systemPrompt` on every turn,
including automation and channel runs. It carries only what a turn cannot recover from on its own:
that the agent is a Norbital agent and what it is there for, that its tool list is what it actually
has and that what bounds its use of the workspace's data is the acting principal's permissions rather
than a curated tool list, that any filesystem it can reach is shared with everyone in the
organisation rather than private to a person, and enough of the `src/` layout to name the file a
change belongs in instead of inventing a settings screen. Those decide the first sentence of a reply,
before
any tool call, so a skill the model was never prompted to fetch cannot repair them. Everything with
depth stays in the skills and loads on demand, because carrying all of it on every turn would be most
of a context window spent on text the turn never needed. An authored prompt is composed after it and
still wins a conflict.

Skills follow the Agent Skills format (https://agentskills.io/specification): a directory with a
`SKILL.md` carrying `name` and `description` frontmatter, plus reference files loaded only when
asked for. Two built-in tools replace what would otherwise have been a bespoke documentation tool —
`list_skills` returns the metadata tier, `read_skill` returns a body or one reference file. Pod ships
`norbital-platform`, covering approvals and policies, records and history and audit, and what an
agent can actually do; and `authoring-tenant-workspace`, which moved here out of a private repository
so that one copy now serves both a workspace agent and the coding agents that build workspaces.

A workspace can add its own under `src/skills/<name>/`. The compiler validates them against the same
rules the host-side generator applies — the spec's name regex and length limits, `name` matching its
directory, required non-empty `description` — and inlines them into the generated workspace, since
markdown is not importable. Host skills win a name collision and the workspace copy is refused with a
diagnostic, because a workspace shadowing `norbital-platform` would replace the only correct account
of how approvals behave. `read_skill` matches file paths verbatim against the list the skill
advertises rather than joining them onto a root.

`@norbital-ai/pod/skills` exports the shipped skills as data so a host can offer them through its own
tooling, and the manifest gains a `skills` entry carrying names and descriptions only.
