# @norbital-ai/ui

## 0.0.2

### Patch Changes

- 1553f56: Make mobile sheet resizing follow the pointer without reactive storage writes, switch collection tables from viewport to container-responsive layouts, and keep organization controls interactive across phone orientation changes.

  Simplify Pod and shared UI reactivity by replacing synchronization effects with derived values, Svelte reactive collections, keyed responsive lifecycles, and attachments for imperative editor/map integrations. Abort superseded remote queries and clean up file-reader cancellation listeners.

## 0.0.1

- Initial baseline release of the shared Svelte component library.
- Collection tables, matrices, and split layouts retain desktop behavior until phone widths.
- Mobile bottom sheets support reliable pointer and keyboard resizing.
- Published Svelte output is valid JavaScript for Vite's SSR module runner.
