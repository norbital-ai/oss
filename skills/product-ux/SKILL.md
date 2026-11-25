---
name: product-ux
agent: true
authoring: true
description: How a workspace's apps, pages and record representations should be composed.
---

1. Compose from shell, layout and view primitives — never raw root markup. Open layout/app references only for what `bolt-primer` leaves open. Operational apps open on live work (records, KPIs, queues, actions) — never landing pages or static how-to cards.
2. **Single-owner chrome:** Primitives own title, description/`(i)` hint, actions, search/filter, empty state, scroll, and Save (`Table`/`Board` `toolbar`, `Section` `{title,icon,hint,actions}`, `Field` `description`, `AppShell`/`RecordShell` header) — never duplicate headings, hints, action bars, or `<DescriptionHint>` outside them.
3. Organize apps by workflow (operations vs configuration), never one page per model. Each model has one primary home; owned children live in their parent's record hub.
4. One concern per view: at most one `Table` or `Board` per page/tab. Split distinct lists into tabs; never stack tables or repeat metrics owned elsewhere.
5. One scroll owner per region per axis: `AppShell` owns chrome; never nest scrolling on one axis. `Table`/`Board` fills its parent and scrolls internally; `Tabs` panels never own scroll.
6. Match data shape: compact `Grid` (2–3 fields/row) in titled `Section`s with `lucide:*` `icon`, timelines for dated series, board+table switchers for stages, discriminator-first forms for polymorphic models, domain pickers (`TimeInput`/`TimeRangeInput`) over raw editors, and bounded charts (`~16–20rem`, never `<Bound size="viewport">`). Keep create/update parity for owned-child matrices, hide pre-scoped parent FKs, lock context-fixed keys with read-only context, scope dependent refs with `where`, and hide `transform`-computed fields. Cap summary strips at 4–5 KPIs (omit zero-value tiles/orphans).
7. Controlled `<Table of={rows}>`: set `kind` (`money`/`decimal`/`int`/`date`/`instant`), `align: 'end'` on numerics/money, `Badge`/`StateBadge` for enums/states, and merge currency+amount into one `money` column.
8. Keep navigation flat: `Tabs` switch views/sub-reports (never `<Combobox>`/`<select>`). Reserve `AppShell.actions` for page-wide scope selectors applied consistently to sibling tabs and create sheets.
9. Surface primary state and next action directly (`Badge`/`StateBadge` + at most one `Button variant="brand"` per view), never buried in `⚡`. Use Lucide icons (never raw `▲▼ℹ⚠`), visible input labels, and parent-owned sizing (no fixed `w-*`/`h-*` on controls).
10. **Headless behaviors & agent readiness (never hand-roll):** compose custom interactive widgets from `@norbital-ai/ui/behaviors` (`skill { name: 'bolt-contract', file: 'behaviors.md' }` and `authoring-tenant-workspace` `references/behaviors-and-composition.md`). Never hand-roll keyboard/Escape navigation, roving focus, outside-click dismissal, focus traps, drag/reorder/resize/panel groups, sliders, menus/trees/grids, radio/switch/toggle/checkbox groups, token/trigger/dropzone/password/color inputs, inline edit, pagination, clipboard, stick-to-bottom, debounce, or `localStorage`. Register custom stateful widgets with `register_control` (or the behavior's `control` option) so Norbius can inspect and drive them via `page`.
11. Simplest general layout wins: fewer pages, fewer components. Artwork needs real sources and alt text. Verify render, scroll, images and console in preview.
