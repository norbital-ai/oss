# `@norbital-ai/ui`

Svelte components, design tokens, collection surfaces, and layout primitives for Norbital tenant
applications.

See the [UI package overview](./docs/README.md) for goals, layering, and styling boundaries.

Import components through their public subpaths:

```svelte
<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Stack } from '@norbital-ai/ui/layout';
</script>
```

Import `@norbital-ai/ui/base.css` once at the application root. Pod's generated client entry imports
it automatically, so tenant apps do not add a second base stylesheet or Tailwind integration.

The wildcard export exposes one subpath per component directory. Additional stable subpaths cover
`collection-table/navigation`, `feature-colors`, JavaScript utilities, editor themes, the logo, and
favicons. Do not import from `build/` or `src/` directly.

## Development

```sh
pnpm --filter @norbital-ai/ui build
pnpm --filter @norbital-ai/ui lint
```
