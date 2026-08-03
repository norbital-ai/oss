# Layout and Scrolling

Composition and scroll ownership. Derived from [interface-ideology.md](interface-ideology.md);
spacing lives in [padding-and-spacing.md](padding-and-spacing.md).

Routing: every record opens through its collection-owned `+representation.svelte`. There are no
pages, no URLs, no SvelteKit routes. The app shell renders the active app; records open as
sheets/dialogs over the current view. Think SPA with a single document scroll context.

## App structure

Every app is the same three-part shape. `Cover` splits chrome from body; the body holds exactly one
region that owns scroll and the app inset.

```svelte
<Cover as="main" top={pageHeading}>
	<Tabs
		animate={false}
		config={[{ name: 'tab1', label: 'Tab 1', icon: 'lucide:kanban', content: tab1Snippet }]}
	/>
</Cover>
```

The three legal bodies:

| Body                                                       | Scroll owner   | Inset owner   |
| ---------------------------------------------------------- | -------------- | ------------- |
| `<Tabs …/>`                                                | `TabsContent`  | `TabsContent` |
| `<Scroll name="…" inset>` — flowing content                | the `Scroll`   | the `Scroll`  |
| `<Bound size="full" inset>` — one self-scrolling component | that component | the `Bound`   |

Nothing else goes directly in the `Cover` body. A bare `CollectionTable` there has no scroll
contract and no inset — that is the shape that renders flush against the shell edge.

## Scroll priority (last-resort scrolling)

Components own their scroll. The outer shell scrolls only as a last resort.

```
Priority 1 (innate)  → Component-internal scroll (table rows, kanban lanes, form fields)
Priority 2 (pane)    → Named Bound+Scroll pair for custom content regions
Priority 3 (tab)     → Tab panel scroll (TabsContent overflow-y-auto)
Priority 4 (sheet)   → Sheet.Content scroll
Priority 5 (shell)   → App shell — only as absolute last resort
```

Components at Priority 1 always scroll first. Their parent containers let them grow until their
min-height is satisfied. Only when multiple Priority 1 components stack beyond the viewport does
Priority 2-5 activate.

## Who owns scroll

| Component                        | Owns scroll | Notes                                                        |
| -------------------------------- | ----------- | ------------------------------------------------------------ |
| `CollectionTable`                | Yes         | Vertical: header sticky, body `overflow-y-auto`              |
| `CollectionKanban`               | Yes         | Horizontal: lane overflow-x-auto, snap                       |
| `CollectionForm`                 | Yes         | Vertical: field area `Scroll`, footer pinned                 |
| `Tabs.Root` / `TabsContent`      | Yes         | `grid min-h-0`, content `overflow-y-auto overscroll-contain` |
| `MatrixRenderer` (bounded=true)  | Yes         | Default; set `bounded={false}` to yield scroll to parent     |
| `Sheet.Content`                  | Yes         | `flex h-full overflow-hidden` + scrollable body              |
| `Scroll` (explicit Bound+Scroll) | Yes         | For custom content that needs local scrolling                |
| Charts / static tables / cards   | No          | Content flows to parent scrollport                           |

**Tab panels scroll by default.** `TabsContent` renders
`overflow-y-auto overscroll-contain [scrollbar-gutter:stable]`. Every app is `Cover top={pageHeading}`
→ `Tabs`, so the tab content region IS the scrollport. Do NOT wrap tab snippet content in `<Scroll>`
or `<Bound><Scroll>` — and do not add `inset` there either.

## The scroll contract

**Never nest two scrollports on the same axis.** The inner one traps scroll — the user gets
"stuck" in a small region, unable to scroll the parent.

**Explicit scroll regions** use `<Bound size="...">` to establish a height contract, with
`<Scroll name="...">` as the single scroll owner inside:

```svelte
<Bound size="full">
	<Scroll name="Quote lines" class="h-full">
		<!-- content -->
	</Scroll>
</Bound>
```

**Clip regions** (no scrolling): `<Bound size="full" clip>` for maps, boards, video that fill a pane.

**`Bound` sizes:** `compact` h-72, `standard` h-[28rem], `tall` h-[40rem], `full` h-full.

Do not use generic `overflow` wrappers, flex/min-size chains, or raw layout flex/grid wrappers.
Clipping is valid only for text truncation, `Frame` media, or an audited popup/sheet boundary.

## Tab snippets

Each tab snippet is ONE of:

**Collection surface** — table/kanban owns scroll. No wrapper needed:

```svelte
{#snippet tab1()}
	<CollectionTable {client} collection="items" query={{ orderBy: { name: 'asc' } }}>
		{#snippet columns({ Column })}
			<Column name="name" card="title" />
		{/snippet}
	</CollectionTable>
{/snippet}
```

**Custom content** — charts, approval tables, summary cards flow directly into the tab scrollport:

```svelte
{#snippet overview()}
	<Grid minimum="panel"><!-- charts, cards, tables --></Grid>
{/snippet}
```

**Split panes** — each pane gets its own height contract:

```svelte
<Split ratio="wide" collapse="switch" switchLabels={['Board', 'Map']} gap="md">
	{#snippet start()}
		<Bound size="tall" pad="sm" class="rounded-lg border bg-card">
			<CollectionKanban {client} collection="jobs" groupBy="status"><!-- ... --></CollectionKanban>
		</Bound>
	{/snippet}
	{#snippet end()}
		<Bound size="tall" clip class="rounded-lg">
			<StaticMap markers={points} />
		</Bound>
	{/snippet}
</Split>
```

## Mobile responsiveness

All layout is container-query driven, not viewport breakpoints.

| Mechanism                 | Breakpoint     | Behavior                                    |
| ------------------------- | -------------- | ------------------------------------------- |
| `Split collapse="stack"`  | `narrow` 40rem | Panes stack vertically                      |
| `Split collapse="switch"` | `narrow` 40rem | Tab toggle between panes                    |
| `Grid minimum="compact"`  | auto-fit 12rem | Cards collapse early for small widgets      |
| `Grid minimum="card"`     | auto-fit 18rem | Medium widgets                              |
| `Grid minimum="panel"`    | auto-fit 26rem | Form fields, standard cards                 |
| Data renderers            | intrinsic      | Shrink to content; `min-width: 0` on parent |

**Data renderers in narrow containers:** every data renderer is wrapped in `min-w-0` via the layout
primitives, so they shrink gracefully rather than "collapsing too fast." The `compact` (12rem)
breakpoint is for genuinely small widgets like stat cards. For form fields and tables, use
`Grid minimum="panel"` (26rem) to keep renderers at a usable width.

**Why not viewport breakpoints:** the app renders inside a `[container-name:pod-app]` container
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

When multiple components stack vertically inside a tab panel:

1. Each component renders at its natural height
2. If the sum exceeds the tab panel height, the tab panel scrolls
3. Individual components scroll internally only when their OWN content exceeds their min-height

## Form layout

```svelte
<CollectionForm {client} collection="items" {recordId} defaultValues={record}>
	{#snippet children({ Field })}
		<Stack gap="md">
			<div>
				<h3 class="text-sm font-semibold">General information</h3>
				<p class="text-sm text-muted-foreground">Section description.</p>
			</div>
			<Grid minimum="panel">
				<Field name="name" />
				<Field name="status" />
				<Column span="all"><Field name="description" /></Column>
			</Grid>
		</Stack>
	{/snippet}
</CollectionForm>
```

- `Grid minimum="panel"` (26rem) for form fields — single column on narrow screens, wraps gracefully
- `Column span="all"` for full-width fields
- Section headings (`h3` + `p`) are NOT duplication — they describe the section, not individual values

## Representation structure

```svelte
{#if record}
	<DetailRepresentation {record} {close} />
{:else}
	<CollectionForm {client} collection="items" submitLabel="Add item" onAfterSubmit={close}>
		{#snippet children({ Field })}
			<Grid minimum="panel">
				<Field name="name" />
				<Column span="all"><Field name="description" /></Column>
			</Grid>
		{/snippet}
	</CollectionForm>
{/if}
```

Detail views use `Tabs variant="underline"` for sections. Each tab renders a `CollectionForm` (for
editable fields) or `CollectionTable` (for related records). Neither needs wrapping in additional
`Scroll` — the detail tab panel owns scroll.

## The primitive catalogue

Our primitives are the [every-layout](https://every-layout.dev) / [bedrock](https://www.bedrock-layout.dev)
set with our own names. If you know those, this is the mapping — and if you are reaching for
something not in this table, you are almost certainly about to write a layout by hand.

| Ours              | Elsewhere                  | The one thing it does                                     |
| ----------------- | -------------------------- | --------------------------------------------------------- |
| `Stack`           | Stack                      | Sibling rhythm down the block axis                        |
| `Inline`          | Inline / Cluster           | Sibling rhythm along the inline axis                      |
| `Cluster`         | Cluster                    | Inline rhythm that wraps                                  |
| `Center`          | Center                     | A measure: `max-inline-size` + auto margins               |
| `Cover`           | Cover                      | Chrome, body, chrome — body takes the remaining height    |
| `Bound`           | PadBox / Frame             | A named height contract                                   |
| `Frame`           | Frame                      | Aspect-ratio media                                        |
| `Grid`            | Grid                       | `auto-fit` tracks with a minimum, no breakpoints          |
| `Columns`/`Column`| Columns                    | Explicit column spans                                     |
| `Split`           | Sidebar / Switcher         | Two panes that collapse on a container query              |
| `Scroll`          | Reel                       | A named scrollport                                        |

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

Every layout here responds to its *container*, never to the browser window, and does it without a
media query: `Grid minimum=` uses `auto-fit`, `Cluster` wraps, `Split collapse=` switches on a
container query. An app renders inside `[container-name:pod-app]` with a sidebar and shell chrome
taking width, so a viewport breakpoint is measuring the wrong box. If you find yourself writing
`sm:`/`md:`/`lg:` for layout, the primitive is either wrong or missing a prop.

## Never build a Tailwind class at runtime

Tailwind emits CSS by scanning source *text*. A class assembled from a variable names a rule that
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

<!-- RIGHT -->
<Cover top={header} class="min-h-svh">
  <Stack as="main" class="h-full justify-center">{@render children()}</Stack>
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

| Intent                        | Prop                                      |
| ----------------------------- | ----------------------------------------- |
| Cross-axis placement          | `align="start\|center\|end\|stretch"`     |
| Main-axis distribution        | `justify="start\|center\|end\|between"`   |
| Take the remaining space      | `grow`                                    |
| Fill the parent's height      | `fill` (`Bound size="full"`)              |
| Space between siblings        | `gap`                                     |
| Page padding                  | `inset`                                   |

`UI10` fails on `items-*`, `justify-*`, `self-*`, `place-*`, `flex-1`, `grow`, `shrink-0` and
`h-full` applied to a primitive that has the equivalent prop.

`class` on a primitive is for what layout does not own — colour, border, radius, typography,
`position: relative`, a background. If you find yourself reaching for a layout class, the primitive
is either the wrong one or is missing a prop; add the prop rather than the class. `Stack` gained
`align`/`justify`/`grow`/`fill` for exactly this reason — without them there was no way to say
"centre this vertically", so every caller wrote `flex-1 justify-center`, and on a `min-h-*` parent
that silently does nothing at all.
