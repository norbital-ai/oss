---
'@norbital-ai/pod': minor
---

Bound a channel agent by its profile's policy rather than by a short tool list.

A Telegram or WhatsApp agent was built a spec inline from the channel's declared `task` and nothing
else, which meant it defaulted to `access: 'read'`, named no workspace tools and no host tools, and
never read `src/+agent.ts`. In practice a channel agent held four tools — `describe_workspace`,
`read_collection`, `list_skills`, `read_skill` — and a workspace had no way to widen it. Meanwhile the
baseline system prompt told that same agent it had been given the whole tool surface and was bounded
by permission rather than by which tools it was handed. On the channel path that was not true.

It is now, for the workspace's own surface. A channel run takes `access: 'write'` and every workspace
agent tool, the same as an interactive run with no authored profile. Nothing there is curated per
agent, because an agent is bounded by what its principal may do and a narrower tool list removes
capability without removing reach — while reading, to anyone auditing it, as though the tool list
were the containment.

What bounds a channel run is the principal it acts as. An interactive run inherits the signed-in
user's permissions; a channel may be a group chat, so there is no single person behind it to inherit
from, and the run acts as the channel's own `kind='agent'` principal, which `pod migrate` places in a
team carrying the channel's declared `policy`. `read_collection` and `write_collection` run
unelevated, so every read and write meets that policy, its hooks and its approval gates exactly as
any other principal would. A channel principal whose team was never reconciled holds no grants and is
refused outright — the profile is the boundary, and there is deliberately no second, tool-shaped one
beside it that could disagree with it.

An authored `src/+agent.ts` is supplementary on this path rather than authoritative, which is the one
place a channel differs from interactive chat. Its prompt, model and budgets are carried; its
`collections`, `access`, `tools` and `hostTools` are not, because permission here belongs to the
channel's policy and a file able to widen or narrow it from the side would make that policy advisory.
The channel's declared `task` composes last — after the baseline prompt and after the authored one —
so the most specific instruction is the one the model reads last.

Host tools are the part the channel's policy does not bound, so a channel run is offered none of
them. A host tool carries no requestor, so it authorizes on the principal it _acts as_, and nothing
in a channel declaration chooses that principal — a host is free to resolve it to something that is
not the channel, and a host running one runtime per organization resolves it to one builder for
everybody. A channel run holding a shell or file-writing host tool would therefore not be refused by
its policy; it would succeed as that builder, against the workspace's own source tree, from a group
chat anyone in the group can post to. `channelAgentSpec` names `hostTools: []` until a binding frame
can carry the acting principal, at which point a channel run should get the host tools its own
principal is entitled to.
