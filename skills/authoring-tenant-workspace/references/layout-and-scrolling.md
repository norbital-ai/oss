# Layout and Scrolling

Composition and scroll ownership. Derived from [interface-ideology.md](interface-ideology.md);
spacing lives in [padding-and-spacing.md](padding-and-spacing.md).

Routing: author app pages with Bolt's `+page.svelte` roles; Bolt owns their URLs and navigation.
Do not add SvelteKit routes to a workspace. Every record opens through its model-owned
`+representation.svelte`, in a sheet/dialog over the current view. Use the shared record controls
so opening and closing a record preserves the page, tabs, filters and scroll position.

## App structure

Every app page uses `AppShell` (identity in its props, page scope and actions in its `actions` snippet —
see [app-structure.md](app-structure.md)). Its body is exactly one region:

The narrow shell shows identity in its navigation header and page actions in a compact toolbar.
Do not add a second banner, title or empty icon block. Model scope and operation controls
remain on the model toolbar.

```svelte
<AppShell icon="lucide:kanban" title={t('jobs.title')} description={t('jobs.description')} variant="full">
	<Tabs
		variant="underline"
		config={[{ name: 'board', label: t('jobs.board'), icon: 'lucide:kanban', content: board }]}
	/>
</AppShell>
```

| Body                                        | Variant          | Scroll owner          | Inset (see padding-and-spacing.md) |
| ------------------------------------------- | ---------------- | --------------------- | ---------------------------------- |
| one model surface                      | `page` (default) | the surface           | the shell's `Bound inset`          |
| `<Tabs …/>`                                 | `full`           | each panel's one body | the panel, or its `Scroll inset`   |
| `<Scroll name="…" inset>` — flowing content | `full`           | the `Scroll`          | the `Scroll`                       |

## Scroll priority (last-resort scrolling)

Components own their scroll. The outer shell scrolls only as a last resort.

```
Priority 1 (innate)  → Component-internal scroll (table rows, kanban lanes, form fields)
Priority 2 (pane)    → Named Bound+Scroll pair for custom content regions
Priority 3 (sheet)   → Sheet.Content scroll
Priority 4 (shell)   → App shell — only as absolute last resort
```

Components at Priority 1 always scroll first. Their parent containers let them grow until their
min-height is satisfied. Only when multiple Priority 1 components stack beyond the viewport does
Priority 2–4 activate.

## Who owns scroll

| Component                   | Owns scroll | Notes                                                     |
| --------------------------- | ----------- | --------------------------------------------------------- |
| `Table`                     | Yes         | Vertical: header sticky, body scrolls                     |
| `Board`                     | Yes         | Horizontal lanes; each lane scrolls vertically            |
| `Matrix`                    | Yes         | Rows page 50 at a time; header row and label column fixed |
| `Form`                      | Yes         | Vertical: field area scrolls, footer pinned               |
| `Tabs`                      | No          | Bounded, clipped, inset; the tab body owns scrolling      |
| `Sheet`                     | Yes         | Scrollable body inside a clipped boundary                 |
| `Scroll` (inside a `Bound`) | Yes         | Custom content that needs local scrolling                 |
| `Chart`, `Pivot`, cards     | No          | Content flows to the parent scrollport                    |

**Tab panels never own scrolling.** `TabsContent` is bounded and clipped so wheel input cannot be trapped
by a root tab panel. Every tab snippet renders exactly one body owner: a self-scrolling model surface,
`Bound` around one self-scrolling component, or a named `Scroll inset` for custom flowing content — the
`Scroll` claims the panel's inset, so the padding lands inside the scrollport.

## The scroll contract

**Never nest two scrollports on the same axis.** The inner one traps scroll — the user gets
"stuck" in a small region, unable to scroll the parent. Repository-health rule **UI16** flags
the common cases automatically.

Every framework scroll owner has the same affordances: the thumb is hidden at rest and appears on
hover, and a directional edge fade appears only where more content exists. Do not recreate either
behavior with component-local scrollbar CSS, gradient overlays, or scroll listeners. Use `Scroll`;
for the exceptional primitive that cannot render `Scroll`, attach `scrollAffordance()` to its actual
scrollport.

### Compound component shells

A compound component keeps its identifying chrome outside its scrollport. Calendar month controls,
weekday headings, table column headings, filters, legends, and pagination remain mounted and fixed;
only the cells/rows beneath them own overflow. When a fixed header must follow horizontal body
scroll, translate its inner track from the body scroll position instead of making the whole shell a
scrollport. Wheel input over that header may forward to the body it labels.

Loading a new page, month, or filter result must preserve the same outer shell. Keep controls,
header, border, legend/footer, and height contract mounted; replace only the data region with
shape-matched placeholder rows or cells (a `Live` read's `status` says when) and set `aria-busy` on
the component. Replacing the whole
component with a paragraph, pulse rectangle, or empty branch is a layout shift and is not a legal
loading state.

### Scroll-trap checklist (UI16)

| Anti-pattern                                                                        | Fix                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `<Scroll>` wrapping `Form`, `Table`, `Board`, `Matrix`, `Tabs`, or another `Scroll` | Remove the outer `Scroll`; the child already owns vertical scroll  |
| `Field class="min-h-64 flex-1"` / `Stack fill` around a matrix inside `Form`        | Drop the nested height fight; let content flow and the form scroll |

```svelte
<!-- WRONG: Scroll around a form that already scrolls -->
<Scroll name="Create job">
	<Form of="jobs" mode="create" />
</Scroll>

<!-- RIGHT: the form pads inside its own boundary -->
<Form of="jobs" mode="create" />
```

**Explicit scroll regions** use `<Bound size="...">` to establish a height contract, with
`<Scroll name="...">` as the single scroll owner inside:

```svelte
<Bound size="full">
	<Scroll name="Quote lines">
		<!-- content -->
	</Scroll>
</Bound>
```

**Clip regions** (no scrolling): `<Bound size="full" clip>` for maps, boards, video that fill a pane.

**`Bound` sizes:** `compact` h-72, `standard` h-[28rem], `tall` h-[40rem], `fit`
`h-[min(42rem,calc(100dvh-14rem))]` floored at `standard`, `full` h-full. `fit` is the viewer-aware
contract: a scrollport that claims the space below a ~14rem chrome band, capped at `tall` — for a
table/kanban/form that should track the viewport instead of guessing a pane size.

Do not use generic `overflow` wrappers, flex/min-size chains, or raw layout flex/grid wrappers.
Clipping is valid only for text truncation, `Frame` media, or an audited popup/sheet boundary.

## Tab snippets

Each tab snippet is ONE of:

**A view** — `Table` / `Board` owns scroll. No wrapper needed:

```svelte
{#snippet items()}
	<Table of="items" columns={['name', 'status']} orderBy="name" />
{/snippet}
```

**Custom content** — charts, approval tables, and summary cards use one explicit bounded scroll owner:

```svelte
{#snippet overview()}
	<Bound size="full">
		<Scroll name="Overview" inset>
			<Grid minimum="panel"><!-- charts, cards, tables --></Grid>
		</Scroll>
	</Bound>
{/snippet}
```

**Split panes** — each pane gets its own height contract:

```svelte
<Split ratio="wide" collapse="switch" switchLabels={['Board', 'Map']} gap="md">
	{#snippet start()}
		<Bound size="tall" pad="sm" class="rounded-lg border bg-card">
			<Board of="jobs" by="status" card={['title', 'site', 'due']} />
		</Bound>
	{/snippet}
	{#snippet end()}
		<Bound size="tall" clip class="rounded-lg">
			<Map of="sites" interactive={false} />
		</Bound>
	{/snippet}
</Split>
```

## Mobile responsiveness

All layout is container-query driven, not viewport breakpoints.

| Mechanism                 | Breakpoint     | Behavior                                     |
| ------------------------- | -------------- | -------------------------------------------- |
| `Split collapse="stack"`  | `narrow` 40rem | Panes stack vertically                       |
| `Split collapse="switch"` | `narrow` 40rem | Tab toggle between panes                     |
| `Grid minimum="compact"`  | auto-fit 12rem | Cards collapse early for small widgets       |
| `Grid minimum="card"`     | auto-fit 18rem | Medium widgets                               |
| `Grid minimum="panel"`    | auto-fit 26rem | Form fields, standard cards                  |
| `Grid tracks="…"`         | explicit       | Known uneven columns (log tables, key/value) |
| Data renderers            | intrinsic      | Shrink to content; `min-width: 0` on parent  |

**Data renderers in narrow containers:** every data renderer is wrapped in `min-w-0` via the layout
primitives, so they shrink gracefully rather than "collapsing too fast." The `compact` (12rem)
breakpoint is for genuinely small widgets like stat cards. For form fields and tables, use
`Grid minimum="panel"` (26rem) to keep renderers at a usable width.

**Why not viewport breakpoints:** the app renders inside a `[container-name:bolt-app]` container
query. The sidebar and shell chrome affect available width. Container queries respond to the actual
rendering area, not the browser window.

## Min-height rules

Components have natural minimum heights. The layout should let them claim their space before
forcing a scrollport:

- Tables: header + 3-4 rows visible (table owns its internal scroll for more rows)
- Kanban: lane headers + 2-3 cards visible per lane
- Forms: all visible fields fit (form owns scroll for overflow)
- Charts: `min-h-[18rem]` via Display component
- Cards: content-dependent, ~6rem minimum

When multiple components stack vertically inside a custom tab body:

1. Each component renders at its natural height
2. If the sum exceeds the available height, the body’s named `Scroll` scrolls
3. Individual components scroll internally only when their OWN content exceeds their min-height

## Form layout

```svelte
<Form of="items" mode="update" id={id}>
	<Stack gap="md">
		<Stack gap="xs">
			<Label>{bolt.t('items.section.general')}</Label>
			<p class="text-meta">{bolt.t('items.section.general_hint')}</p>
		</Stack>
		<Grid minimum="panel">
			<Field name="name" />
			<Field name="status" />
			<Column span="all"><Field name="description" /></Column>
		</Grid>
	</Stack>
</Form>
```

- `Grid minimum="panel"` (26rem) for form fields — one column on narrow screens, wraps gracefully.
- `Column span="all"` for full-width fields.
- A section heading and hint describe the section, not individual values; they are not duplication.

## Representation structure

A `+representation.svelte` renders inside `RecordShell` and takes `{ view: RecordView<'<c>'> }`.
With no stored row (`RecordShell mode="create"`) it is the create form; with one it is the record.
Split a detail view into `RecordShell` `tabs` — one `Form` for editable fields, one `Table` per related
model — and none needs an extra `Scroll`, because each view owns its own scrolling. A custom tab
uses one explicit `Bound` + named `Scroll` body. A stepper keeps every `Field` mounted and hides steps.

## The primitive catalogue

Our primitives are the [every-layout](https://every-layout.dev) / [bedrock](https://www.bedrock-layout.dev)
set with our own names. If you know those, this is the mapping — and if you are reaching for
something not in this table, you are almost certainly about to write a layout by hand.

| Ours               | Every Layout / Bedrock  | The one thing it does                                                                                               |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Stack`            | Stack                   | Sibling rhythm down the block axis; `divided` draws row hairlines                                                   |
| `Inline`           | Inline                  | One row that never wraps                                                                                            |
| `Cluster`          | Cluster / InlineCluster | One row that wraps                                                                                                  |
| `Center`           | Center                  | A measure: `max-inline-size` + auto margins                                                                         |
| `Cover`            | Cover (app frame)       | Chrome, body, chrome; `center` centres the body's principal                                                         |
| `Bound`            | Box / PadBox            | A named height contract (`size`), the page `inset`, or `pad`                                                        |
| `Frame`            | Frame / Ratio           | Aspect-ratio media (img, video) or a centred placeholder                                                            |
| `Grid`             | Grid                    | `auto-fit` tracks with a `minimum`, or `tracks` for known columns                                                   |
| `Columns`/`Column` | Columns                 | Exact counts and spans; collapses to one column below `collapse`                                                    |
| `Split`            | Sidebar                 | Two panes with a named `ratio`; collapses (stack or switch) when it is narrow                                       |
| `Scroll`           | Reel / scroll container | A named scrollport; `snap` for reels, `max` for a capped region                                                     |
| `Imposter`         | Imposter                | The one sanctioned overlap: centre, fill, a bar or strip, a corner, an edge; `layer`, `offset`, `position="sticky"` |

Details that remove the old escape hatches:

- **`class` is applied last on every primitive.** Layout (gap, align, justify, direction, wrap) is
  props only — the doctor enforces it — so what a class can still say is a floor (`min-h-24`), a
  layer (`z-20`), a colour (`divide-border/40`), a size, or responsive visibility, and it wins.
- **Every primitive takes `bind:ref`** and can render `as="button" | "a" | "label"`: a clickable
  row or chip IS the primitive, with no inner layout span.
- **`Imposter`** placements: `center`, `fill`, `top`/`bottom` (bars), `start`/`end` (full-height
  strips), the four corners, `center-start`/`center-end`. `offset` (`none`…`md`), `layer`
  (`under`/`raised`/`overlay`/`modal`), `position` (`absolute`, `fixed`, `sticky` for a sticky
  header, column or rail). Children are optional for a decorative layer.
- **`Stack`** `divided`, `reverse`; **`Inline`/`Cluster`** `divided` (a segmented strip);
  **`Grid`** `align`, `rowGap`; **`Columns`** 1–7 and `collapse="none"` (no self-measurement, safe
  in a shrink-to-fit popover); **`Bound size="auto"`** (content height: a clip or inset boundary);
  **`Scroll max`** caps are viewport-aware.

`Split` and `Columns` measure **themselves** (each is its own inline-size container), so a split in
a narrow grid cell collapses even inside a wide page.

Every primitive is enforced: the doctor `layoutPack` (UI5–UI27) fails on raw `flex`/`grid`,
`gap-*`, `items-*`, `justify-*`, `flex-col`/`-wrap`, `grid-cols-*`, `divide-*`, `space-*`,
`overflow-*` scroll, `absolute`/`fixed`/`sticky`, arbitrary heights and literal insets — including
inside `class={cn(…)}` literals and behind `sm:`-style variants. It runs in `oss`, every template,
and Colony.

Each does exactly one thing. Two primitives composed always beat one primitive plus classes — that
is the whole reason the set is this small.

## Spacing between siblings belongs to the parent

This is the rule `Stack` exists for. A child that carries `mb-4` has an opinion about what comes
after it, so it cannot be reordered, reused, or conditionally rendered without leaving a gap behind
or doubling one up. The parent owns the rhythm and writes it once, as `gap`.

```svelte
<!-- WRONG: every child now encodes its position in the list -->
<Stack gap="none">
	<img class="mb-4" />
	<h1 class="mb-1">Title</h1>
	<p>Subtitle</p>
</Stack>

<!-- WRONG: `space-y-*` is the same mistake spelled as a utility, and it fights the primitive's gap -->
<Stack class="space-y-4">…</Stack>

<!-- RIGHT: one declaration, and a nested Stack where the rhythm genuinely differs -->
<Stack gap="md" align="center">
	<img />
	<Stack gap="xs" align="center">
		<h1>Title</h1>
		<p>Subtitle</p>
	</Stack>
</Stack>
```

`UI7` reports the coarse case on any element; `UI13` reports any margin at all on a direct child of
a primitive that already owns `gap`. Different rhythm between two groups is a nested `Stack`, never
a margin.

## Centring a measure is `Center`, not an alignment

`align="center"` is a flex alignment: it shrink-wraps children to their content width. That is right
for an icon above a label and wrong for a column of prose, which is why callers who reach for it end
up writing `w-full max-w-3xl` on the child to undo the shrink-wrap — three declarations for one
intent, and the element is no longer full-width below the measure.

```svelte
<!-- WRONG -->
<Stack align="center"><div class="w-full max-w-3xl">…</div></Stack>
<Stack class="mx-auto max-w-5xl">…</Stack>

<!-- RIGHT -->
<Center measure="wide"><Stack gap="md">…</Stack></Center>
```

`UI14` fails on `mx-auto` paired with `max-w-*`.

## No magic layout dimensions

Height is the one measurement you never actually know. `h-[32rem]` is a guess about content, and it
is wrong at the first long label or empty state — either clipping or leaving a void. Let content size
itself, and where a definite height is genuinely required (a scrollport, a map, a board) name it
through `Bound size=` so the deliberate cases are countable.

```svelte
<!-- WRONG -->
<Stack class="h-dvh">…</Stack>
<Scroll class="h-[40rem]">…</Scroll>

<!-- RIGHT -->
<Cover class="min-h-dvh">…</Cover>
<Bound size="tall"><Scroll name="Lines">…</Scroll></Bound>
```

`UI15` fails on `h-[…]`, `w-[…]`, `h-screen` and `h-dvh` applied to a primitive. `min-h-*` on the
outermost element of a document is fine — that is a floor, not a guess.

## Responsive without breakpoints

Every layout here responds to its _container_, never to the browser window, and does it without a
media query: `Grid minimum=` uses `auto-fit`, `Cluster` wraps, `Split collapse=` switches on a
container query. An app renders inside `[container-name:bolt-app]` with a sidebar and shell chrome
taking width, so a viewport breakpoint is measuring the wrong box. If you find yourself writing
`sm:`/`md:`/`lg:` for layout, the primitive is either wrong or missing a prop.

## Never build a Tailwind class at runtime

Tailwind emits CSS by scanning source _text_. A class assembled from a variable names a rule that
was never generated, so the element simply has no such style — nothing throws, nothing logs, and the
layout silently falls back to the browser default.

```svelte
<!-- WRONG: no CSS is ever emitted for this -->
<div class={`[grid-template-rows:${rows}]`}>

<!-- RIGHT: a value that varies belongs in `style` -->
<div style={`grid-template-rows: ${rows}`}>

<!-- ALSO RIGHT: enumerate the literal variants so the scanner can see them -->
<div class={twoRow ? '[grid-template-rows:auto_minmax(0,1fr)]' : '[grid-template-rows:minmax(0,1fr)]'}>
```

`UI12` fails the build on this. It is an error rather than a warning because the symptom never points
at the cause: `Cover` shipped for months with its row template built this way, and it presented as
three unrelated bugs — a page header that would not stay at the top, a body that would not fill the
remaining height, and a dialog footer that would not pin to the bottom.

## Vertical centring needs a definite height

`flex-1 justify-center` centres nothing when the container's height comes from `min-h-*` rather than
a definite height — there is no free space to distribute, so the child sits at the top. Use `Cover`:
its middle row is `minmax(0,1fr)`, which is a definite track.

```svelte
<!-- WRONG: sits at the top of the viewport -->
<Stack class="min-h-svh">
	{@render header()}
	<Stack as="main" class="flex-1 justify-center">{@render children()}</Stack>
</Stack>

<!-- RIGHT: Cover's body is a definite track, and `center` centres its principal in it -->
<Cover top={header} center>
	{@render children()}
</Cover>
```

## A workspace transition evicts, it does not overlay

While the active organization is changing, the previous organization's records are still mounted. A
translucent overlay leaves them legible under the new organization's name. Render the destination or
render nothing — never both.

## Compose primitives; never re-describe layout in classes

A layout primitive owns its algorithm. The moment you write the algorithm again as classes on that
primitive, two sources describe the same thing and the class silently wins — so the prop is a lie and
the next reader cannot tell which one is load-bearing.

Alignment, distribution, growth and fill are **props**, not classes:

```svelte
<!-- WRONG -->
<Stack class="flex-1 items-center justify-center">…</Stack>
<Bound class="h-full">…</Bound>

<!-- RIGHT -->
<Stack grow align="center" justify="center">…</Stack>
<Bound size="full">…</Bound>
```

| Intent                   | Prop                                    |
| ------------------------ | --------------------------------------- |
| Cross-axis placement     | `align="start\|center\|end\|stretch"`   |
| Main-axis distribution   | `justify="start\|center\|end\|between"` |
| Take the remaining space | `grow`                                  |
| Fill the parent's height | `fill` (`Bound size="full"`)            |
| Space between siblings   | `gap`                                   |
| Page padding             | `inset`                                 |

`UI10` fails on `items-*`, `justify-*`, `self-*`, `place-*`, `flex-1`, `grow`, `shrink-0` and
`h-full` applied to a primitive that has the equivalent prop.

`class` on a primitive is for what layout does not own — colour, border, radius, typography,
`position: relative`, a background. If you find yourself reaching for a layout class, the primitive
is either the wrong one or is missing a prop; add the prop rather than the class. `Stack` gained
`align`/`justify`/`grow`/`fill` for exactly this reason — without them there was no way to say
"centre this vertically", so every caller wrote `flex-1 justify-center`, and on a `min-h-*` parent
that silently does nothing at all.
