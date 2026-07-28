# Tenant Application Navigation State

Application navigation state is the **shared record-detail navigation platform** inside
`@norbital-ai/pod`. `PageSurfaceState` is an internal runtime class name, not a tenant-authored layout
component.

The host proxies tenant requests into the checkpoint isolate; the Pod runtime shell bootstraps
`PageSurfaceState` and persists record navigation in the URL.

---

## User experience (what people see)

```text
┌─ TenantWorkspaceShell ─────────────────────────────────────────────────────┐
│ [Sidebar]                       │  Main app surface (+<name>.svelte)      │
│  PLATFORM — host plugins        │  [data-workspace-app-surface]            │
│  APPLICATIONS — tenant apps     │                                          │
│                                 │                                          │
│                                 │  CollectionTable / Kanban / custom UI    │
│                                 │       │ click row                        │
│                                 │       ▼                                  │
│                                 │  pushes ?stack= in URL                   │
└─────────────────────────────────┴──────────────────────────────────────────┘
                                          │
                    viewMode=sidesheet    ▼
              ┌──────────────────────────────────────┐
              │  Right sheet (DetailSurfaceStack)     │
              │  ┌────────────────────────────────┐  │
              │  │ Record detail snippet           │  │
              │  │ (registered by table/kanban)    │  │
              │  └────────────────────────────────┘  │
              │  [breadcrumb chips from hydrated scope] │
              └──────────────────────────────────────┘
```

**Platform** and **Applications** are uppercase muted section labels in the sidebar, not navigation
items. Host plugins and tenant apps remain visually distinct. The implementation lives in
[`pod-shell.svelte`](../src/lib/runtime/pod-shell.svelte).

Opening a record does **not** navigate to a new document route. The app stays on
`/app/{appName}`; the selected record stack lives in `?stack=` and the shell renders the detail
sheet when `viewMode === 'sidesheet'`.

---

## Contract

`NavState` is a single selected record stack — no `surface` discriminator:

```ts
type NavState = {
	stack: NavStackItem[];
};

type NavStackItem = {
	collection_name: string;
	record_id: string;
	node_id: string; // which registered detail snippet to render
	viewMode: 'page' | 'sidesheet';
	expand?: string[];
};
```

The stack is serialized in `?stack=`. `SYSTEM_NAV_NODE_IDS` in
[`client/types.ts`](../src/lib/client/types.ts) defines host system node IDs; tenant apps register
their own `routeKey` values through `DetailSurfaceService`.

---

## Context hierarchy (runtime)

```text
PodApp → /_pod/bootstrap → PodShell
  └─ PageSurfaceState (also PlatformStateContext)
       ├─ manifestCtx, user, organization
       ├─ access_control (AccessControlService — admin checks)
       └─ navigation (DetailSurfaceService)
            ├─ register({ routeKey, renderDetail }) — table/kanban snippets
            ├─ push/pop stack items → URL ?stack=
            └─ resolve(routeKey) → Snippet for DetailSurfaceStack
```

The Pod shell reads the URL stack, hydrates scope server-side when needed, and renders the resolved
collection surface through
[`detail-surface-stack.svelte`](../src/lib/runtime/detail-surface-stack.svelte).

---

## Route context (lightweight)

`getRouteContext(url)` in
[`route_context.ts`](../src/lib/client/utils/route_context.ts) only identifies where the URL belongs:

- `organization`
- optional `appName`
- optional `isWorkspaceManifest`

It does **not** decide rendering behavior. `getBaseUrlForRouteContext(url)` uses that context to clear or preserve `?stack=` while staying on the current app or workspace URL.

---

## Scope hydration (data plane)

Stack hydration runs **inside the checkpoint isolate**, not in Core.

```text
Client URL ?stack=[{ collection_name, record_id, node_id, viewMode, expand? }, ...]
    │
    ▼
scope_operation / detail remotes (collection-runtime)
    │
    ▼
hydrateStackItems(stack)   ← scope_hydration.server.ts
    │
    ▼
TDynamicApplicationScopeData = TBaseScope & {
  selected_record: TNorbitalDBRecord | null;
  bread_crumbs: Array<{ label: string; warn?: boolean }>;
}
```

`FetchStackFrameInput` carries only `{ stack: ContextNavStackItem[] }`.

---

## Collection UI integration

`CollectionTable` and `CollectionKanban` register detail snippets and open records via the surface navigation API:

```text
User clicks row in CollectionTable
    │
    ├─ buildCollectionDetailNavTarget({ collection, recordId, expand })
    ├─ mergeCollectionDetailNavStack(currentUrl, target)
    └─ DetailSurfaceService navigates → ?stack= updated
              │
              ▼
       DetailSurfaceStack renders registered snippet
       CollectionApprovalPanel may show in detail actions
```

Create, display, and edit overrides are one compiler-owned collection role: `+representation.svelte`.
Collection surfaces resolve it from the generated static map and pass `record={null}` for create or the
existing row for display/edit; call sites do not register or override record components.

---

## Important files

| File                                                                                        | Role                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------------- |
| [`client/types.ts`](../src/lib/client/types.ts)                                             | `NavState`, `NavStackItem`, scope types |
| [`client/stack-frame.ts`](../src/lib/client/stack-frame.ts)                                 | Stack-frame hydration input             |
| [`detail_surface.service.ts`](../src/lib/client/subservices/detail_surface.service.ts)      | Stack URL mutation and registration     |
| [`page_surface_state.svelte.ts`](../src/lib/client/page_surface_state.svelte.ts)            | `PageSurfaceState` class                |
| [`pod-shell.svelte`](../src/lib/runtime/pod-shell.svelte)                                   | Sidebar, main surface, and detail sheet |
| [`route_context.ts`](../src/lib/client/utils/route_context.ts)                              | Lightweight route context               |
| [`scope_hydration.server.ts`](../src/lib/server/collection/scope/scope_hydration.server.ts) | `hydrateStackItems()`                   |
| [`collection-table.svelte`](../../ui/src/collection-table/collection-table.svelte)          | Table and detail registration           |
| [`template_workspaces/*/src/apps`](../../../template_workspaces)                            | Tenant application entry components     |

---

## Related docs

- [FORM_SYSTEM.md](./FORM_SYSTEM.md) — inline forms in table/kanban/detail
- [SYNC_ENGINE.md](./SYNC_ENGINE.md) — local reads, optimistic writes, and live queries
