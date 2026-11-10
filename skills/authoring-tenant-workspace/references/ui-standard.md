# Template UI standard

Checks every template page passes. Rule homes: [app-structure.md](app-structure.md), [layout-and-scrolling.md](layout-and-scrolling.md), [typography.md](typography.md), [controller-surfaces.md](controller-surfaces.md).

1. A page is an `AppShell` around one view: icon, 1 to 3 word title, one-sentence description up to 90 characters with a final period.
2. An app's name never repeats the workspace name; the app icon is the header icon.
3. One concern per tab; tab title equals view title; one tab size.
4. The toolbar is fixed; no button above, beside or in a view header.
5. Record sheet: title `record_label` or UUID, overline the singular model label, subtitle fields; one primary action, the rest in overflow.
6. A row click opens that row's record and nothing else: no link, relation link or inspect popover in a cell. A row that stands for another record (a report line, a snapshot item) opens it with `onOpen`. Row operations are row `actions`, never loose buttons in cells.
7. Every label comes from the catalog, never a humanized key.
8. Kinds carry meaning: `date`, `money`, `currency`, markdown; no hand-written formatting.
9. The kit formats: date medium; instant medium with short time; money `CODE 1,234.00`; decimals trimmed; empty `—`.
10. A state is a coloured badge; an enum or tag is a neutral chip.
11. Empty and loading are the kit's `EmptyState` and the view's skeleton.
12. Submit reads "Save" or the action's verb; required and help come from the model.
13. Layout only through primitives and typography roles; one view per scroll.
14. A regional `locale` and `tz`; base and `zh` catalogs cover every visible string; check phone width with a finger: every widget reflows, and the kit's own do (table rows, forms two fields to a row, calendar days over an agenda). A hand-built widget states its own small-screen layout.
15. Disclosure supports the task: primary inputs visible, consistent field order across create, edit and read.
16. Every chart answers a stated decision.
17. Reuse the record controller, capability reasons, approvals and structured renderers; related edits are explicit operations preserving unloaded children.
18. A table's New inside a parent record uses `toolbar.new` with a native `Sheet` and `RecordShell mode="create"` carrying the parent in `values`. `where` scopes the read only. Close on committed or `pending_approval`. Verify the foreign key through the real UI.
19. One chromatic action per view: `Button variant="brand"` at most once; brand orange is never decoration.
20. Surfaces separate with hairlines: `border border-border` on `bg-card`. Cards 12px maximum, controls 6px, badges 4px, pills round. No `shadow-card`, glow or 16px+ radius.
