# @norbital-ai/pod

## 0.0.1

- Initial public release of Pod as a precompiled, Core-agnostic Svelte runtime for plain Vite
  tenant workspaces.
- Replaced the Pod CLI, SvelteKit routes, adapter, configuration, and remote-function runtime with the `pod()` Vite plugin and Pod-owned HTTP runtime.
- Made `svelte`, `zod`, `runed`, `@iconify/svelte`, and `vite` direct workspace peer dependencies. Pod no longer publishes peer-package gateways.
- Moved app discovery, client/server bundling, migration generation, runtime host generation, Tailwind integration, and base CSS wiring into the Vite plugin.
- Preserved optional IFC viewing behind a lazy client boundary so construction workspaces do not compile the viewer stack into their initial application path.
