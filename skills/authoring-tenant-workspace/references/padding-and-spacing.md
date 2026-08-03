# Padding and Spacing

Who owns the space. Derived from [interface-ideology.md](interface-ideology.md) axioms 1
(elements never space themselves), 4 (one owner per responsibility), and 5 (tokens, never values).

## The three questions

Every spacing decision is one of exactly three cases. Answer the question, and the owner is fixed —
there is no judgement call left.

| The space is…                             | Owner                                   | Mechanism                     |
| ----------------------------------------- | --------------------------------------- | ----------------------------- |
| 1. **between siblings**                   | their parent                            | `gap` on the layout primitive |
| 2. **inside a visible boundary**          | the element that draws the boundary     | that component's own padding  |
| 3. **between the shell edge and content** | the one inset owner in the `Cover` body | the **app inset** (below)     |

**Case 1 — between siblings.** `Stack`, `Inline`, `Cluster`, `Grid`, `Columns`, `Split`, and `Cover`
all take `gap`. A child never contributes to the space between itself and its neighbour.

```svelte
<Stack gap="md">
	<!-- correct: parent owns the rhythm -->
	<SummaryCard />
	<CollectionTable … />
</Stack>
```

```svelte
<div>
	<!-- wrong: child owns space it cannot see -->
	<SummaryCard />
	<CollectionTable class="mt-4" … />
</div>
```

**Margin is banned in an app file.** `mt-*`, `mb-*`, `ml-*`, `space-y-*` between siblings always
means a parent is missing a `gap`. (Inside a component's own internals, an optical nudge on a
non-sibling relationship — a caption under its own heading — is a component-internal detail, not app
authoring.)

**Case 2 — inside a boundary.** Anything with a visible edge pads its own contents and nothing
outside compensates: `PageHeader`, `Card`, `Sheet.Content`, `CollectionTable` cells, popovers. If a
card looks cramped, the card is wrong — do not add padding to its parent.

**Case 3 — the app inset.** This is the case that goes wrong, so it has its own section.

## The app inset

One value for the whole system, exported from `@norbital-ai/ui/layout`:

| Token            | Value               | Used by                                                                  |
| ---------------- | ------------------- | ------------------------------------------------------------------------ |
| `INSET_CLASS`    | `px-4 py-2 sm:px-6` | content regions: `TabsContent`, `Bound`/`Scroll` `inset`                 |
| `INSET_X_CLASS`  | `px-4 sm:px-6`      | full-bleed chrome with its own vertical rhythm (`PageHeader`)            |
| `INSET_MX_CLASS` | `mx-4 sm:mx-6`      | chrome that draws its own background and so cannot pad itself (tab list) |

Never write these classes literally in an app file. Use `inset` on the primitive.

### Padding follows scroll

**Whoever owns the scrollport at a level owns the inset at that level.** The scroll ladder in
[layout-and-scrolling.md](layout-and-scrolling.md) and the padding ladder are the same ladder.

The reason is mechanical, not stylistic. The inset must live _inside_ `overflow`:

- padding inside the scrollport scrolls with the content; padding on its parent does not
- the scrollbar stays on the true container edge instead of floating a gutter inward
- content scrolls _under_ the top inset instead of being clipped at the pad line

Pad an ancestor of a scrollport and all three break at once.

### One inset per app surface

`Cover` never pads. `PageHeader` pads itself (case 2). The `Cover` body holds **exactly one** inset
owner, chosen by what is in it:

| `Cover` body holds                                        | Inset owner                      | Author writes               |
| --------------------------------------------------------- | -------------------------------- | --------------------------- |
| `Tabs`                                                    | `TabsContent` (`contentPadding`) | nothing — it is automatic   |
| flowing content (cards, charts, summary tables)           | the `Scroll` itself              | `<Scroll name="…" inset>`   |
| one component owning internal scroll (table, kanban, map) | the `Bound` region around it     | `<Bound size="full" inset>` |

```svelte
<!-- Tabs: the panel is the scrollport and insets itself. The tab list aligns via INSET_MX_CLASS. -->
<Cover as="main" top={pageHeading}>
	<Tabs animate={false} config={[…]} />
</Cover>
```

```svelte
<!-- One self-scrolling surface: the region insets, because the table is a surface, not a scrollport. -->
<Cover as="main" top={pageHeading}>
	<Bound size="full" inset>
		<CollectionTable {client} collection="repayment_agreements">…</CollectionTable>
	</Bound>
</Cover>
```

```svelte
<!-- Flowing content: the scrollport insets itself. -->
<Cover as="main" top={pageHeading}>
	<Scroll name="Loans overview" inset>
		<Grid minimum="panel">…</Grid>
	</Scroll>
</Cover>
```

The third row is the one apparent exception, and it is principled: a `CollectionTable` is a
**surface** whose scroll lives in an inner element, so its own box is a visible edge sitting in a
region. The space around it is case 1/2 region space, not scrollport padding. The test is simple —
if the element you are looking at has `overflow` on it, put the inset on it; if the element merely
_contains_ something that scrolls, put the inset on the region around it.

### The two failure modes

Both come from nobody deciding who owns the inset.

**Zero-pad** — content flush against the shell edge, misaligned with the page header above it.
Cause: the `Cover` body child is neither a `Tabs` nor an `inset` region.

**Double-pad** — content sits two gutters in, misaligned with its own sibling chrome. Causes: an
`inset` wrapper placed _around_ a `Tabs` (the tab list gets `mx` + the wrapper's `px`), or an
`inset` wrapper placed _inside_ a `TabsContent` (which already insets).

**Check:** walk from `Cover` down to the content and count the elements applying the app inset.
It must be exactly 1.

```svelte
<!-- WRONG: double pad. Tabs already insets its list and its panels. -->
<Cover top={pageHeading}>
	<Bound size="full" inset>
		<Tabs config={[…]} />
	</Bound>
</Cover>

<!-- WRONG: double pad. TabsContent already insets this snippet. -->
{#snippet catalogue()}
	<Bound size="full" inset>…</Bound>
{/snippet}

<!-- WRONG: zero pad. Nothing between the shell edge and the table. -->
<Cover top={pageHeading}>
	<CollectionTable {client} collection="repayment_agreements">…</CollectionTable>
</Cover>
```

### Nested shells

The rule is scale-free: **one inset per scroll boundary.** A sheet is its own shell. `Sheet.Content`
is the boundary; each scrolling panel inside it pads itself (`p-5 sm:p-6`); a `Tabs` whose panels
already pad sets `contentPadding={false}`, and its tab list then goes flush automatically. Detail
representations inherit this and add nothing.

## The scale

| Token  | `gap`   | `pad`   |
| ------ | ------- | ------- |
| `none` | 0       | 0       |
| `xs`   | 0.25rem | 0.25rem |
| `sm`   | 0.5rem  | 0.5rem  |
| `md`   | 1rem    | 1rem    |
| `lg`   | 1.5rem  | 1.5rem  |
| `xl`   | 2rem    | —       |

Defaults: `Cover gap="md" pad="none"`, `Bound pad="none"`. `Bound inset` wins over `Bound pad` —
they are different concerns and should not be combined. Arbitrary values (`p-[13px]`, `gap-[18px]`)
never belong in an app file.
