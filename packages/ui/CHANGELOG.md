# @norbital-ai/ui

## 0.1.25

### Patch Changes

- Keep collection tables, matrices, and split layouts in their desktop presentation until the viewport reaches phone size, restore reliable pointer and keyboard resizing for mobile bottom sheets, and tighten the shared badge typography and vertical spacing.
- Updated dependencies
  - @norbital-ai/platform-utils@0.1.23

## 0.1.24

### Patch Changes

- a951167: Extract AsyncLocalStorage from workspace.ts into handler-api-storage.server.ts, making the authoring module client-safe. Replace re-exports/ with gateway/, remove unused ./authoring/workspace subpath export, and add extended type re-exports to authoring/index.ts. Remove pg dependency from platform-utils (inline escapeIdentifier). Swap tiptap extension-link/extension-underline for @tiptap/markdown in ui.

## 0.1.23

### Patch Changes

- 02761d6: Strip TypeScript from svelte-package .svelte output for Vite 8 SSR module runner compatibility. The module runner externalizes packages during dev SSR, requiring valid JavaScript in .svelte files' script blocks.

## 0.1.2

### Patch Changes

- 0627a98: Initial automated bump to clear changesets baseline
- Updated dependencies [0627a98]
  - @norbital-ai/std@0.1.2
