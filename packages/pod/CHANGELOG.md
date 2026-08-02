# @norbital-ai/pod

## 0.0.3

### Patch Changes

- 6178bff: Give every workspace the agent surface, and let the tenant settings tabs span their pane.

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

- Updated dependencies [6178bff]
  - @norbital-ai/ui@0.0.3

## 0.0.2

### Patch Changes

- e0dd1a9: Group tenant and host-owned settings under one shell with Core provenance badges, preserve plugin
  placement across the server/browser boundary, standardize workspace page tabs, fully unmount the
  outgoing tenant document while an organization switch is in progress, and restore bounded Kanban
  lane scrolling after the layout-primitive migration.
- 2495a32: Export Drizzle's SQL expression builder from the workspace authoring surface so models can declare
  read-only generated relational projections. This lets provenance variants retain their canonical
  JSON audit record while exposing indexed foreign-key paths for nested queries.
- 4e095e3: Keep browser replica synchronization demand-driven so background collection warming cannot compete with visible reads or issue requests for inaccessible collections. Close a tab's replica transport when the page is actually discarded.
- Updated dependencies [e0dd1a9]
- Updated dependencies [3b63018]
  - @norbital-ai/ui@0.0.2

## 0.0.1

- Initial public release of the Pod authoring SDK, tenant runtime, sync engine, agent runtime, and
  host boundary.
