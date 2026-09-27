# `@norbital-ai/ui`

Svelte views, field inputs, primitives, design tokens and layout primitives for Bolt workspaces.

See the [UI package overview](./docs/README.md) for goals, layering, and styling boundaries.

Four entries: `.` (views, inputs, editors, primitives), `./layout`, `./capture` (`CaptureKit`, so its
face engine loads only in pages that import it) and `./base.css`; `./assets/*` holds the logo and favicons.

```svelte
<script lang="ts">
	import { Button, Table } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
</script>
```

Import `@norbital-ai/ui/base.css` once at the application root. Bolt's generated client entry imports
it automatically, so tenant apps do not add a second base stylesheet or Tailwind integration.

Do not import from `build/` or `src/` directly.

## Development

```sh
pnpm --filter @norbital-ai/ui build
pnpm --filter @norbital-ai/ui lint
```
