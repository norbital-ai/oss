# @norbital-ai/pod

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
