---
name: product-ux
agent: true
authoring: true
description: How a workspace's apps, pages and record representations should be composed.
---

1. Compose from shell, layout and view primitives — never raw markup. Operational apps open on live work (records, KPIs, queues, actions), never static landing cards.
2. **Single-owner chrome:** Primitives own titles, hints, actions, search/filter, empty states, scroll and Save (`Table`/`Board` `toolbar`, `Section`, `Field`, `AppShell`/`RecordShell`) — never duplicate headings, hints, action bars or `<DescriptionHint>` outside them.
3. Organize apps by workflow (operations vs configuration), never one page per model. Owned children live in their parent's record hub.
4. One concern per view: at most one `Table` or `Board` per page/tab; split distinct lists into tabs.
5. One scroll owner per region per axis: `AppShell` owns chrome; `Table`/`Board` fills its parent and scrolls internally; `Tabs` panels never own scroll.
6. Match data shape and use horizontal space: compact `Grid` (`minimum="compact"`, 3–4 fields/row) in titled `Section`s with `lucide:*` `icon`. Order scalar fields before `wide` (`col-span-full`) fields (`notes`, `address`, structured/markdown/CEL) so wide fields never break rows mid-grid; lay out composite/union snippets (`editors`/`viewers`) in `<Grid minimum="compact" gap="md">` (only long sub-fields `col-span-full`), never 1-field-per-row vertical `<Stack>`; never isolate one scalar in its own section; and render `<Field>` in place for redacted/narrow-output attributes instead of omitting them with `{#if}` so redaction never shifts layout. Use `Timeline` (`group` for multi-item days) for dated series, board+table switchers for stages, discriminator-first polymorphic forms, domain pickers (`TimeInput`/`TimeRangeInput`), and bounded charts (`~16–20rem`, merging same-unit series onto one multi-series chart). Keep create/update parity on child matrices, hide pre-scoped FKs and `transform`-computed fields, scope dependent refs with `where`, and cap KPI strips at 4–5 tiles.
7. Controlled `<Table of={rows}>`: set `kind` (`money`/`decimal`/`int`/`date`/`instant`), `align: 'end'` on numerics/money, `Badge`/`StateBadge` for enums/states, and merge currency+amount into one `money` column.
8. Keep navigation flat: `Tabs` switch views/sub-reports (never `<Combobox>`/`<select>`). Reserve `AppShell.actions` for page-wide scope selectors shared across tabs and create sheets.
9. Surface primary state and next action directly (`Badge`/`StateBadge` + at most one `Button variant="brand"` per view), never buried in `⚡`. Use Lucide icons (never `▲▼ℹ⚠`), visible labels, and parent-owned sizing (no fixed `w-*`/`h-*` on controls).
10. **Headless behaviors & agent readiness:** compose custom widgets from `@norbital-ai/ui/behaviors` (`bolt-contract` `behaviors.md` and `references/behaviors-and-composition.md`). Never hand-roll keyboard/Escape/focus/roving/outside-click/drag/resize/sliders/menus/trees/grids/groups/inline-edit/pagination/clipboard/stick-to-bottom/debounce/`localStorage`. Register custom stateful widgets with `register_control` (or `control`) so Norbius can drive them via `page`.
11. Simplest layout wins. Artwork needs real sources and alt text. Verify render, scroll, images and console in preview.
