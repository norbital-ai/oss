---
name: product-ux
agent: true
authoring: true
description: How a workspace's apps, pages and record representations should be composed.
---

Every concern has one home, every concept one name. Mechanics: `authoring-tenant-workspace` `references/app-structure.md`; review: `references/ui-standard.md`.

## Structure

1. Organize apps by workflow (operations vs configuration), never one page per model. Operational apps open on live records and actions, never landing cards.
2. A record's tabs partition its concerns: every field, figure and list lives in exactly one tab, the one whose concern it serves; the record's own tab holds its identity and the fields no other tab owns.
3. Derived figures (totals, KPIs, charts, balances) live in the tab of the concern they measure, beside the records they summarize, never on the record's own tab.
4. Owned child lists live in their parent's hub, one tab each; a record filed under a child appears only inside that child.
5. A setting has one scope: the narrowest where its value really varies (workspace, team, member, record), never two. A rule every record shares lives in the configuration app, not on each record.
6. One concern per view: at most one `Table` or `Board` per page or tab; distinct lists get distinct tabs.

## Names

7. Label tabs, sections, fields and actions in the user's words; never a bare abbreviation, code, enum value or internal term (explain an unavoidable domain term in `help` or the toolbar's `description`).
8. One concept, one name; two concepts, two names; never two fields encoding one fact.

## Views

9. Primitives own titles, hints, actions, search, filters, empty states, scroll and Save (`toolbar`, `Section`, `Field`, `AppShell`/`RecordShell`); never add headings, hints or action bars outside them.
10. One scroll owner per region and axis: `AppShell` owns chrome; `Table`/`Board` fill their parent and scroll inside; `Tabs` panels never scroll.
11. **Linked views share one selection.** Selecting a row of a list paired with a picture of the same records (map, model, plan, calendar, chart) focuses the picture on it alone, framed; selecting again or clearing restores the whole; selecting in the picture selects the row. Opening the record is a row action.
12. Forms: compact `Grid` (`minimum="compact"`) in titled `Section`s with a `lucide:*` `icon`; scalars before `wide` fields; no one-scalar sections; `<Field>` kept for redacted fields; the scoped parent ref hidden; no server-derived inputs.
13. Match the data's shape: `Timeline` for dated series, board/table switchers for stages, domain pickers (`TimeInput`, `TimeRangeInput`), bounded charts (~16–20rem) answering a stated decision, KPI strips of 4–5 non-empty figures.
14. Keep navigation flat: `Tabs` switch views (never `Combobox` or `<select>`); `AppShell.actions` holds only a scope every tab shares.
15. Surface state and the next action directly (`StateBadge`, at most one `Button variant="brand"` per view), never buried in `⚡`. Lucide icons, visible labels, parent-owned sizing.
16. **A view keeps its shape.** State, progress and errors show in place on what they concern (badge, tone, icon, a reserved status line, a control's pending state); never insert or remove a banner or block that moves content.
17. **One path per action.** One control per action on a view; a second path only on another view where the person already works on that thing (a price in a pricing table and on its product), and rarely.
18. **Headless behaviors & agent readiness:** compose custom widgets from `@norbital-ai/ui/behaviors` (`references/behaviors-and-composition.md`). Never hand-roll keyboard, focus, roving, outside-click, drag, resize, menus, grids, inline edit, pagination, clipboard, debounce or `localStorage`. Register custom stateful widgets with `register_control` so Norbius can drive them via `page`.
19. Simplest layout wins. Artwork needs real sources and alt text. Verify render, scroll, images and console in preview.
