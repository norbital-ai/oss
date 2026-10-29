# Padding and Spacing

Who owns the space. Derived from [interface-ideology.md](interface-ideology.md) axioms 1
(elements never space themselves), 4 (one owner per responsibility), and 5 (tokens, never values).

## The three questions

Every spacing decision is one of exactly three cases. Answer the question, and the owner is fixed —
there is no judgement call left.

| The space is…                             | Owner                               | Mechanism                     |
| ----------------------------------------- | ----------------------------------- | ----------------------------- |
| 1. **between siblings**                   | their parent                        | `gap` on the layout primitive |
| 2. **inside a visible boundary**          | the element that draws the boundary | that component's own padding  |
| 3. **between the shell edge and content** | the scrollport of that region       | the **app inset** (below)     |

**Case 1 — between siblings.** `Stack`, `Inline`, `Cluster`, `Grid`, `Columns`, `Split`, and `Cover`
all take `gap`. A child never contributes to the space between itself and its neighbour.

```svelte
<Stack gap="md">
	<!-- correct: parent owns the rhythm -->
	<SummaryCard />
	<Table … />
</Stack>
```

```svelte
<div>
	<!-- wrong: child owns space it cannot see -->
	<SummaryCard />
	<Table class="mt-4" … />
</div>
```

**Margin is banned in an app file.** `mt-*`, `mb-*`, `ml-*`, `space-y-*` between siblings always
means a parent is missing a `gap`. (Inside a component's own internals, an optical nudge on a
non-sibling relationship — a caption under its own heading — is a component-internal detail, not app
authoring.)

**Case 2 — inside a boundary.** Anything with a visible edge pads its own contents and nothing
outside compensates: `Sheet`, `Dialog`, `Table` cells, popovers. If a
card looks cramped, the card is wrong — do not add padding to its parent.

**Case 3 — the app inset.** This is the case that goes wrong, so it has its own section.

## The app inset

One value for the whole system, owned by `@norbital-ai/ui/layout`. You never write it: you put
`inset` on a `Bound` or `Scroll`, and the components below decide whether to apply it.

| Token       | Value               | Applied by                                                |
| ----------- | ------------------- | --------------------------------------------------------- |
| inset       | `px-4 py-2 sm:px-6` | `Bound inset`, `Scroll inset`, a tab body (provisionally) |
| strip inset | `mx-4 sm:mx-6`      | the tab strip, only when nothing above it already pads    |

A literal `px-4 sm:px-6` in an app file is a doctor error (UI8).

### The rule: the scrollport owns the inset

**Exactly one element pads the page edge in each content region, and it is the element that
scrolls.** The components enforce it through a layout context, so the author's only decision is
where the scrollport is:

| Element                         | Pads the edge when…                                                                                                       | Its subtree after it |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `Scroll inset`, `Bound inset`   | no ancestor pads — it _owns_ the region                                                                                   | flush                |
| a `Tabs` body (every tab panel) | no ancestor pads, **until** a `Scroll`/`Bound inset` inside claims the inset — then it goes flush and the scrollport pads | flush                |
| the tab strip                   | no ancestor pads (read reactively, so a claim above updates them)                                                         | —                    |
| `Sheet`, `Dialog`, `Popover`    | always a **new** region: a padded sheet owns it, a `flush` sheet leaves it to the first scrollport inside                 | —                    |

Why the scrollport: padding inside the scrollport scrolls with the content, keeps the scrollbar on
the true container edge, and lets content scroll _under_ the top inset instead of clipping at a pad
line. Pad an ancestor of a scrollport and all three break.

Consequences you can rely on:

- `inset` on a nested `Bound`/`Scroll` is harmless — it pads only if nothing above does. You never
  count wrappers to avoid double padding; the context does.
- A tab panel holding a `Table` is padded by the panel (the table is a view, not a
  scrollport). A tab panel holding `Scroll inset` is padded by the `Scroll`.
- Nested `Tabs` never add a second gutter: the inner panels see the outer owner and stay flush.
- There is no `contentPadding` prop and no padding class on a region: region padding is `inset`.

### App surfaces

`AppShell` is the root of every app (see [app-structure.md](app-structure.md)). Its body:

| `AppShell` body holds                      | Write                                                             |
| ------------------------------------------ | ----------------------------------------------------------------- |
| one view (`Table`, `Board`, `Matrix`)      | `AppShell` (default `page` variant pads) + the surface            |
| `Tabs`                                     | `AppShell variant="full"` + `Tabs` — the panels pad               |
| flowing content (cards, charts, summaries) | `AppShell variant="full"` + `<Scroll name="…" size="fill" inset>` |

```svelte
<!-- Tabs: each panel pads; a panel that scrolls its own content claims the inset for its Scroll. -->
<AppShell icon="lucide:users" title="People" description="…" variant="full">
	<Tabs tabs={[…]} />
</AppShell>

{#snippet overview()}
	<Scroll name="Overview" size="fill" inset>…</Scroll> <!-- claims the panel's inset: the Scroll pads -->
{/snippet}

{#snippet profiles()}
	<Table of="employees" columns={[…]} /> <!-- the panel pads -->
{/snippet}
```

### The two failure modes

**Zero-pad** — content flush against the shell edge. Cause: an `AppShell variant="full"` body with
no `Tabs`, no `inset` scrollport, and no padded panel.

**Double-pad** — two gutters. With the context this happens only through a literal padding class
(`p-5`, `px-4`) on a region wrapper, or a component that pads its own outer edge. Region padding is
never a class; it is `inset`.

**Check:** in the rendered DOM, `[data-bound-inset]`, `[data-scroll-inset]` and padded tab panels
together must appear exactly once between the shell edge and any piece of content.

## The scale

| Token  | `gap`   | `pad`   |
| ------ | ------- | ------- |
| `none` | 0       | 0       |
| `xs`   | 0.25rem | 0.25rem |
| `sm`   | 0.5rem  | 0.5rem  |
| `md`   | 1rem    | 1rem    |
| `lg`   | 1.5rem  | 1.5rem  |
| `xl`   | 2rem    | —       |

Defaults: `Cover gap="md" pad="none"`, `Bound pad="none"`. `Bound inset` and `Bound pad` are different
concerns: `pad` is a boundary's own interior (case 2), `inset` is the page edge (case 3). Do not combine them. Arbitrary values (`p-[13px]`, `gap-[18px]`)
never belong in an app file.
