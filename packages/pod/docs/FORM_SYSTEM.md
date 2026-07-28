# Form System

Status: **Pod 1.0 authoring contract**. This document is the sealed public surface.

## Contract

Collection forms are Pod collection surfaces. They read the unified `client` from Pod context and use the
same policy-filtered mutation path as every other client. Schema-derived create and record forms are the
default. Tenant authors override them only with one collection-owned role:

```text
src/collections/<collection>/+representation.svelte
```

`+representation.svelte` imports generated `RepresentationProps` from adjacent `./$types.js`. It branches
on `record`: `null` is create, and a row is display/edit. There is no separate create role. A collection
surface does not accept a representation at its call site. Shared presentation belongs in ordinary
adjacent Svelte components.

## Behavior

- `CollectionTable`, `CollectionKanban`, and `CollectionForm` receive context, collection, query, view,
  and display data through Pod runtime facilities.
- The generated form owns validation, editable-field selection, submit lifecycle, and policy/approval handling.
  Submits go through `client.db` mutations; affected live queries re-evaluate locally — there is no query
  invalidation or refetch.
- Custom renderers come from the static custom-type map generated from
  `src/custom-types/<name>/+renderer.svelte`; they use discriminated display/edit props.
- A form uses normal shell document scroll by default. A local scrolling composite must use a named,
  explicit `Bound` + `Scroll` boundary.
- Keep editable controls inside the form. Do not repeat the same editable fact in a read-only summary.

## Data flow

```text
Schema + custom-type roles
        ↓
Compiler-generated metadata and renderer map
        ↓
Collection surface / generated form
        ↓
client.db.<collection>.create | update | delete
        ↓
policy, hooks, approval, audit, direct persistence
        ↓
affected live queries re-evaluate
```

Authoring examples live in [`template_workspaces/`](../../../template_workspaces).
