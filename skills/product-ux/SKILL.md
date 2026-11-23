---
name: product-ux
agent: true
authoring: true
description: How a workspace's apps, pages and record representations should be composed.
---

1. Compose from shell, layout and view primitives — never raw root markup. Open layout/app references only for what `bolt-primer` leaves open. This is an operational web application, never a landing or marketing page: the primary home screen must display live operational work (records, KPIs, queues, and actions) — never static step-by-step instructions or how-to-use cards.
2. **Single-owner chrome:** Every primitive owns its chrome slots — title, description/`(i)` info hint, actions, search/filter, empty state, scroll, and Save. Pass those into the primitive's own props (`Table`/`Board` `toolbar.{title,description,actions}`, `Section` `{title,icon,hint,actions}`, `Field` `description`, `AppShell`/`RecordShell` header) — never bolt duplicate headings, helper paragraphs, action bars, or standalone `<DescriptionHint>` icons outside a primitive that already owns that slot.
3. Organize apps by workflow (e.g. operations vs configuration), never one page per model. Every model has one primary home; owned children live inside their parent's record hub.
4. One concern per view (app page, app tab, or record tab): at most one `Table` or `Board` per view. Separate distinct lists into tabs; never stack tables or repeat metrics owned by another page/tab.
5. One scroll owner per region per axis: `AppShell` owns page chrome; never nest scrolling containers on one axis. `Table`/`Board` fills its parent and scrolls internally; `Tabs` panels never own scroll.
6. Match representations to data shape: compact `Grid` (2–3 fields/row) in meaningful `Section`s (every titled `<Section>` must carry an appropriate `lucide:*` `icon`), timelines for dated series, board+table switchers for stages, discriminator-first forms for polymorphic models, and bounded charts (`~16–20rem`, never `<Bound size="viewport">`). Cap summary strips at 4–5 headline KPIs, omitting zero-value tiles and orphan rows.
7. Controlled `<Table of={rows}>`: declare `kind` (`money`/`decimal`/`int`/`date`/`instant`), `align: 'end'` on numeric/money columns, `Badge`/`StateBadge` for enums/states, and merge currency+amount into one `money` column.
8. Keep navigation flat: `Tabs` (stepping down by level; vertical left for deep sets) switch views/sub-reports — never `<Combobox>` or `<select>`. Reserve `AppShell.actions` strictly for page-wide scope selectors (period, legal entity).
9. Surface primary state and next workflow action directly (`Badge`/`StateBadge` + at most one `Button variant="brand"` per view), never hidden in the `⚡` menu. Use Lucide icons (never raw `▲▼ℹ⚠`), visible labels on all inputs, and parent-owned sizing (no fixed `w-*`/`h-*` on controls).
10. Simplest general layout wins: fewer pages, fewer components. Artwork needs real sources and alt text. Verify render, scroll, images and console in preview.
