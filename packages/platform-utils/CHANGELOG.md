# @norbital-ai/platform-utils

## 0.1.23

### Patch Changes

- Encode the immutable 64-hex package and OCI build contract in new `vite-2` checkpoint identities
  while retaining explicit parsing for historical `vite-1` package-key checkpoints.

## 0.1.22

### Patch Changes

- a951167: Extract AsyncLocalStorage from workspace.ts into handler-api-storage.server.ts, making the authoring module client-safe. Replace re-exports/ with gateway/, remove unused ./authoring/workspace subpath export, and add extended type re-exports to authoring/index.ts. Remove pg dependency from platform-utils (inline escapeIdentifier). Swap tiptap extension-link/extension-underline for @tiptap/markdown in ui.

## 0.1.2

### Patch Changes

- 0627a98: Initial automated bump to clear changesets baseline
- Updated dependencies [0627a98]
  - @norbital-ai/std@0.1.2
