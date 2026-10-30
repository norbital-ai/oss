# `@norbital-ai/ui`

Svelte views, field inputs, primitives, design tokens and layout primitives for Bolt workspaces.

See the [UI package overview](./docs/README.md) for goals, layering, and styling boundaries.

Public entries: `.` (views, inputs, editors, primitives), `./layout`, `./brand` (brand and access
artwork), `./capture` (`CaptureKit`, so its face engine loads only in pages that import it), `./effect`
(the mounted Svelte Effect edge) and `./base.css`; `./assets/*` holds the logo and favicons.

```svelte
<script lang="ts">
	import { Button, Table } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
</script>
```

Import `@norbital-ai/ui/base.css` once at the application root. Bolt's generated client entry imports
it automatically, so tenant apps do not add a second base stylesheet or Tailwind integration.

Do not import from `build/` or `src/` directly.

**One tab size.** Every tab strip in the realm (an app's page strip, a page's `Tabs`, Workspace
Studio, Command Center, settings, record sheets, a calendar's view switch, a `Split` switch) is the
same compact size: a 1.75rem trigger with `px-3`, `text-xs` and a `size-3.5` icon, in a 2rem strip
(`src/primitives/tabs/style.ts`). There is no size prop. The three types, segmented (the default),
underline and chips, differ in appearance only; the nesting level picks the type (`level` overrides
it). `Tabs` (a strip with bodies) and `TabStrip` (a strip alone: page links, or buttons switching a
view the caller renders) are the only tab implementations: never hand-roll a `role="tab"` strip or
restyle a trigger's height, padding or font. On touch screens a tab's minimum target is 32px; other
controls retain the standard 44px. A horizontal `Tabs` strip moves the tabs that do not fit under
More; a `TabStrip` scrolls horizontally.

## Development

```sh
pnpm --filter @norbital-ai/ui build
pnpm --filter @norbital-ai/ui lint
```
