---
name: product-ux
agent: true
authoring: true
description: How a workspace's apps, pages and record representations should be composed.
---

1. Compose from shell, layout and view primitives — never raw root markup. Open layout/app references only for what `bolt-primer` leaves open.
2. Organize apps by workflow (e.g. operations vs configuration), never one page per model. Every model has one primary home; owned children live inside their parent's record hub.
3. One concern per view (app page, app tab, or record tab): at most one `Table` or `Board` per view. Separate distinct lists into tabs; never stack tables or repeat metrics owned by another page/tab.
4. One scroll owner per region per axis: `AppShell` owns page chrome; never nest scrolling containers on one axis. `Table`/`Board` fills its parent and scrolls internally; `Tabs` panels never own scroll.
5. Match representations to data shape: compact `Grid` (2–3 fields/row) in meaningful `Section`s, timelines for dated series, board+table switchers for stages, discriminator-first forms for polymorphic models, and bounded charts (`~16–20rem`, never `<Bound size="viewport">`). Cap summary strips at 4–5 headline KPIs, omitting zero-value tiles and orphan rows.
6. Controlled `<Table of={rows}>`: declare `kind` (`money`/`decimal`/`int`/`date`/`instant`), `align: 'end'` on numeric/money columns, `Badge`/`StateBadge` for enums/states, and merge currency+amount into one `money` column.
7. Keep navigation flat: `Tabs` (stepping down by level; vertical left for deep sets) switch views/sub-reports — never `<Combobox>` or `<select>`. Reserve `AppShell.actions` strictly for page-wide scope selectors (period, legal entity).
8. Surface primary state and next workflow action directly (`Badge`/`StateBadge` + at most one `Button variant="brand"` per view), never hidden in the `⚡` menu. Use Lucide icons (never raw `▲▼ℹ⚠`), visible labels on all inputs, and parent-owned sizing (no fixed `w-*`/`h-*` on controls).
9. Simplest general layout wins: fewer pages, fewer components. Artwork needs real sources and alt text. Verify render, scroll, images and console in preview.
