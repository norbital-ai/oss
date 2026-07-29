---
'@norbital-ai/pod': patch
'@norbital-ai/ui': patch
---

Make mobile sheet resizing follow the pointer without reactive storage writes, switch collection tables from viewport to container-responsive layouts, and keep organization controls interactive across phone orientation changes.

Simplify Pod and shared UI reactivity by replacing synchronization effects with derived values, Svelte reactive collections, keyed responsive lifecycles, and attachments for imperative editor/map integrations. Abort superseded remote queries and clean up file-reader cancellation listeners.
