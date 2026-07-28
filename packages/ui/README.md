# `@norbital-ai/ui`

Svelte components, design tokens, collection surfaces, and layout primitives for Norbital tenant
applications.

Import components through their public subpaths:

```svelte
<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Stack } from '@norbital-ai/ui/layout';
</script>
```

Import `@norbital-ai/ui/base.css` once at the application root. Build with
`pnpm --filter @norbital-ai/ui build`.
