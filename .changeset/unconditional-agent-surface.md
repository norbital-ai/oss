---
'@norbital-ai/pod': patch
---

Give every workspace the agent surface, and let the tenant settings tabs span their pane.

The shell gated the agent FAB and the `/agent` route on an authored `src/+agent.ts` profile, but
`agentChat` and `agentChatStart` are plain authenticated commands and were always callable whatever
the shell rendered. Hiding the surface never removed the reach behind it, so the UI is no longer
gated and the fallback profile is the real boundary. That fallback is the intent rather than a hole
in it: an agent someone is talking to should reach what that person reaches, so leaving `collections`
unset widens `allowedCollections` to every tenant collection precisely so the ceiling comes from
policy instead of the spec — `read_collection` runs `findMany` unelevated, `write_collection` is not
offered, and no host tool is. `src/+agent.ts` is for the case policy cannot cover: a channel with no
authenticated requestor to scope against, such as a public WhatsApp or Telegram surface.

`workspaceProvidesAgentSurface` and `workspaceAuthorizesAgentSurface` no longer take the manifest's
`agent` entry. Both are internal to the Pod shell and are not reachable through any package export.

The tenant settings tabs now pass `listClass="mx-0 w-full"` so the row squares up with the header and
the panel below it instead of floating short of the surface, and the redundant "Tenant-owned
configuration" eyebrow above the "Tenant settings" heading is gone.
