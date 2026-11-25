# Layout and scrolling

Composition and scroll ownership. Spacing: [padding-and-spacing.md](padding-and-spacing.md). Props: query `@norbital-ai/ui/layout`.

## Page & scroll ownership

- Pages use Bolt page roles (no SvelteKit routes). Records open in a `Sheet` preserving page state.
- `AppShell` body is one region: `variant="page"` (one model surface, shell pads), `variant="full"` with `Tabs` (panel pads), or `variant="full"` with `<Scroll name size="fill" inset>` (`Scroll` pads).
- **Scroll owners:** `Table`, `Board`, `Form`, `RecordShell`, `Sheet`, `Scroll size="fill"`. **Non-owners:** `Tabs`, `Chart`, cards.
- **Scroll priority:** component-internal → named `Scroll` pane → `Sheet` → `AppShell` (last resort).
- **Rules:** never nest two scrollports on one axis (no `Scroll` wrapping `Form`, `Table`, `Board`, `Tabs` or another `Scroll` — use `<Bound size="viewport">` for a non-embedded `Table` inside a `Scroll`). Tab panels never own scroll (render one view, `<Scroll size="fill" inset>` or `fill` `Split`). Compound components keep chrome outside their scrollport. Loading replaces only the data region with `aria-busy` skeletons.

## Sizing & responsive

- Every box takes `size`: `content` (default, natural height) or `fill` (shares remaining space, floored by `min_height`). `Bound` adds `viewport` (for a view inside a `Scroll`) and `clip` (map/video).
- Layout responds to container, never viewport (`sm:`/`md:` layout classes mean the wrong primitive): `Grid` `minimum` (`compact` 12rem forms/record fields/widgets, `card` 18rem cards/KPIs, `panel` 26rem wide panes — keep compact scalar fields grouped before `wide`/`col-span-full` fields, and put composite/union sub-fields in `<Grid minimum="compact">`, never a vertical `<Stack>`) or `tracks`; `Cluster` wraps; `Split` (`ratio`, `collapse: 'stack' | 'switch'` below 40rem).

## Primitives & banned classes

| Primitive | Job |
| --- | --- |
| `Stack` / `Inline` / `Cluster` | vertical rhythm (`divided`, `reverse`) / single row / wrapping row |
| `Center` / `Cover` / `Bound` / `Frame` | measure / chrome+body+chrome (`center`) / height+`inset`+`pad`+`clip` / aspect ratio |
| `Grid` / `Columns`+`Column` / `Split` | auto-fit or `tracks` / exact spans / two panes |
| `Scroll` / `Imposter` | named scrollport (`axis`, `max`, `snap`, `inset`) / sanctioned overlap in `relative` parent |

- Layout is props only (`align`, `justify`, `size="fill"`, `gap`, `inset`); every primitive supports `bind:ref` and `as="button" | "a" | "label"`.
- **Banned on primitives** (including in `cn(...)` or responsive prefixes): `flex`, `grid`, `gap-*`, `items-*`, `justify-*`, `self-*`, `place-*`, `flex-1`, `grow`, `shrink-0`, `h-full`, `h-screen`, `h-dvh`, `flex-col`, `grid-cols-*`, `divide-*`, `space-*`, `overflow-*`, `absolute`/`fixed`/`sticky`, `mx-auto`+`max-w-*`, and arbitrary `h-[...]`/`w-[...]`. Never build Tailwind classes dynamically at runtime (use `style` or literal variants). Keep stepper `Field`s mounted and hidden.
