# @norbital-ai/pod

## 0.0.2

### Patch Changes

- 1553f56: Make mobile sheet resizing follow the pointer without reactive storage writes, switch collection tables from viewport to container-responsive layouts, and keep organization controls interactive across phone orientation changes.

  Simplify Pod and shared UI reactivity by replacing synchronization effects with derived values, Svelte reactive collections, keyed responsive lifecycles, and attachments for imperative editor/map integrations. Abort superseded remote queries and clean up file-reader cancellation listeners.

- Updated dependencies [1553f56]
  - @norbital-ai/ui@0.0.2

## 0.0.1

- Initial public release of Pod as a precompiled, Core-agnostic Svelte runtime for plain Vite
  tenant workspaces.
- Replaced the Pod CLI, SvelteKit routes, adapter, configuration, and remote-function runtime with the `pod()` Vite plugin and Pod-owned HTTP runtime.
- Made `svelte`, `zod`, `runed`, `@iconify/svelte`, and `vite` direct workspace peer dependencies. Pod no longer publishes peer-package gateways.
- Moved app discovery, client/server bundling, migration generation, runtime host generation, Tailwind integration, and base CSS wiring into the Vite plugin.
- Preserved optional IFC viewing behind a lazy client boundary so construction workspaces do not compile the viewer stack into their initial application path.
