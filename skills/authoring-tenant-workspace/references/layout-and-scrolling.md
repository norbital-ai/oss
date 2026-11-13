# Layout and scrolling

Composition and scroll ownership. Spacing: [padding-and-spacing.md](padding-and-spacing.md). Primitive props: query the layout entry's exported component types.

## Routing

Author pages with Bolt's page roles; add no SvelteKit routes. A record opens through its representation in a sheet over the current view, preserving page, tabs, filters and scroll.

## Page body

`AppShell`'s body is one region. The narrow shell shows identity in its navigation header: add no second banner or title.

| Body | Variant | Scroll owner | Inset |
| --- | --- | --- | --- |
| one model surface | `page` | the surface | the shell's `Bound inset` |
| `Tabs` | `full` | each panel's one body | the panel, or its `Scroll inset` |
| `<Scroll name size="fill" inset>` | `full` | the `Scroll` | the `Scroll` |

## Sizing

Every box takes the same `size`:

- `content` (default): its own size, never squeezed; the nearest scroll owner scrolls.
- `fill`: the space left, shared with `fill` siblings, floored by `min_height`. In a definite-height parent it takes that height.
- `Bound` adds `viewport`: a height below the page chrome, for a view inside content that already scrolls.

There is no `grow`, `shrink` or `h-full`. A view never takes `min-h-[…]`. Nothing scrolls sideways except `Scroll axis="x"`.

| Context | Write |
| --- | --- |
| view is the region | the view directly: it fills |
| view beside other content | `Section size="fill"` or a `fill` primitive, `min_height` its floor |
| view inside a `Scroll` | `<Bound size="viewport">` |
| board | horizontal board, vertical lanes, never the page |
| clip region (map, video) | `<Bound size="fill" clip>` |

## Scroll priority

1. Component-internal: table rows, lanes, form fields.
2. Pane: a named `Scroll`.
3. Sheet content.
4. App shell: last resort.

## Who owns scroll

- Yes: `Table`, `Board`, `Form`, `RecordShell`, `Sheet`, `Scroll size="fill"`.
- No: `Tabs`, `Chart`, cards.

## Tables, boards and tabs

- A table or board fills its parent region and scrolls inside itself; it never makes its parent overflow. Only when the parent's available height is below the view's `min_height` may it exceed it, and then the parent scrolls.
- `Tabs` follow their nesting level: the first level is the default style (`level` 1), the second underline (2), the third chips (3).
- Choose orientation by the layout's complexity: many sections or deep nesting take `orientation="vertical"`, always on the left (`side="start"`), never the right; otherwise horizontal.

## The scroll contract

- Never nest two scrollports on one axis: the inner one traps scroll. Remove a `Scroll` around `Form`, `Table`, `Board`, `Tabs` or another `Scroll`.
- A tab panel never owns scroll. Each tab snippet is one body owner: a self-scrolling view, or a named `Scroll size="fill" inset`, or a `fill` `Split` whose panes are `fill` boxes.
- Use `Scroll` for the hidden thumb and edge fade; a primitive that cannot render it attaches `scroll_affordance()`. No local scrollbar CSS or scroll listeners.
- No generic `overflow` wrappers or flex chains. Clip only for truncation, `Frame` media or an audited sheet boundary.
- A compound component keeps its chrome outside its scrollport: month controls, headers, filters, pagination stay mounted.
- `RecordShell` always owns a visible native footer and a fixed header. Its main content overflows inside that frame,
  including custom representations, tabs, read-only views and create/edit forms. Use `footer` and `footer_actions`
  to decorate the existing footer; do not add a second record footer or scroll the whole record frame.
- Loading keeps the outer shell mounted: replace only the data region with shape-matched placeholders and set `aria-busy`. Replacing the component is a layout shift.

## Responsive

- Layout responds to its container, never the viewport: `Grid minimum` auto-fits, `Cluster` wraps, `Split` and `Columns` measure themselves. `sm:`/`md:` for layout means a wrong primitive.
- `Grid minimum`: `compact` 12rem for small widgets, `card` 18rem, `panel` 26rem for form fields. Direct `Field` children go down to half a narrow container, two to a row, and two `Columns` of fields stay two to a row. `tracks` for known uneven columns.
- `Split collapse`: `stack` or `switch` below 40rem.
- Data renderers shrink; do not pick `compact` for them.

## Min heights

Components claim natural minimums before a scrollport appears. Stacked components render at natural height; the body's `Scroll` scrolls the sum.

## Primitives

| Primitive | One job |
| --- | --- |
| `Stack` | block rhythm; `divided`, `reverse` |
| `Inline` | one row, no wrap |
| `Cluster` | one row that wraps |
| `Center` | a measure |
| `Cover` | chrome, body, chrome; `center` centres the body in a definite track |
| `Bound` | height contract, `inset` or `pad` |
| `Frame` | aspect-ratio media |
| `Grid` | `auto-fit` tracks or `tracks` |
| `Columns`/`Column` | exact counts and spans |
| `Split` | two panes with a `ratio` |
| `Scroll` | a named scrollport; `max` caps a `content` scroll; `snap` |
| `Imposter` | the one sanctioned overlap |

- `class` applies last; layout is props only, so a class says floor, layer, colour, or visibility.
- Every primitive takes `bind:ref` and `as="button" | "a" | "label"`: a clickable row is the primitive.
- Two primitives composed beat one plus classes.

## Banned on primitives

Raw `flex`/`grid`, `gap-*`, `items-*`, `justify-*`, `self-*`, `place-*`, `flex-1`, `grow`, `shrink-0`, `h-full`, `flex-col`, `grid-cols-*`, `divide-*`, `space-*`, `overflow-*`, `absolute`/`fixed`/`sticky`, arbitrary heights, literal insets, including in `cn(…)` and behind `sm:`. The layout rules fail them.

| Intent | Prop |
| --- | --- |
| Cross axis | `align` |
| Main axis | `justify` |
| Take the rest | `size="fill"` |
| Space between siblings | `gap` |
| Page padding | `inset` |

If no prop fits, the primitive is wrong or missing a prop; add the prop, not a class.

## Rules

- A parent owns sibling rhythm as `gap`; a different rhythm is a nested `Stack`, never a margin.
- Centre a measure with `Center`, not `align="center"` plus `max-w-*`. `mx-auto` with `max-w-*` fails.
- Height is never guessed: `h-[…]`, `w-[…]`, `h-screen`, `h-dvh` on a primitive fail. Use `size="fill"` or `Bound size="viewport"`. `min-h-*` on a document's outermost element is a floor, allowed.
- Never build a Tailwind class at runtime: no CSS is emitted and the build fails. Put varying values in `style`, or enumerate literal variants.
- Vertical centring needs a definite height: use `Cover size="fill" center`, not `flex-1 justify-center`.
- A workspace transition renders the destination or nothing, never a translucent overlay over the old organization's records.
- A stepper keeps every `Field` mounted and hides steps.
