# Template UI Standard

Checks every template page passes. Each links to the rule's home; this page only lists them.

1. Every page is an `AppShell` around one view: header icon, 1–3 word title, one-sentence description
   (≤ 90 characters, final period); task scope belongs in the view's toolbar.
   [app-structure](app-structure.md#appshell-and-the-header)
2. An app's name never repeats the workspace name; the app icon is the header icon.
3. One concern per tab; tab title = view title; the shell's page strip is level 1; a child-only
   model belongs within its parent record; compact inline values need no extra tab.
   [app-structure](app-structure.md#tabs-break-the-view)
4. The toolbar is fixed, one row: title, ⓘ, then every widget (scope `controls`, search, filter, ⚡)
   flush left in that order; New alone flush right. At phone width the row wraps in the same order,
   New still last and right. No button above, beside or in a view header.
   [app-structure](app-structure.md#the-page-is-its-subject)
5. Record sheet: title = the record's label, overline = the singular model label, subtitle = fields;
   one primary action, the rest in overflow.
6. A row click opens the record; one-row operations are the view's row `actions`, never loose buttons in cells.
7. Every label comes from the catalog (model, field, enum value), never a humanized key.
   [internationalization](internationalization.md#key-conventions)
8. Never an id on screen. [controller-surfaces](controller-surfaces.md#6-never-show-system-uuids--even-for-relationships)
9. Kinds carry meaning: `date`, `money`, `currency`, markdown text; no hand-written formatting.
   [models-and-modeling](models-and-modeling.md#field-kinds)
10. The kit formats: a date medium; an instant medium with short time; money `CODE 1,234.00`;
    decimals trimmed; empty `—`.
11. A state is a coloured badge; an enum or tag is a neutral chip.
12. Empty and loading are the kit's `EmptyState` and the view's skeleton.
13. Ordinary data-entry default: a compact, polished form with a `Grid` and meaningful sections
    where useful. Steps, widgets and interactive editors can fit other tasks better. Submit reads
    "Save" or the action's verb; required and help come from the model.
    [app-structure](app-structure.md#form-layout-defaults)
14. Layout only through primitives and typography roles; one view per scroll.
    [layout-and-scrolling](layout-and-scrolling.md), [typography](typography.md)
15. The workspace sets a regional `locale` and `tz`; `+messages.ts` and `+zh.messages.ts` cover every
    visible string; check phone width before calling it done.
16. Progressive disclosure supports the task. Keep primary inputs visible; use sections for
    meaningful attribute groups, inline related records or complex attributes, without repeating
    headings, descriptions or values. Short records can stay flat. When a secondary section starts
    closed, give it a useful `summary`; preserve mounted fields and open validation errors.
    Use consistent field order across create, edit and read. Generated record views can declare
    grouping with `RecordShell`'s `sections` prop.
    [app-structure](app-structure.md#form-layout-defaults)
17. Every chart answers a stated decision with clear scope, units and range. Remove decorative
    charts and duplicate summaries. [app-structure](app-structure.md#useful-charts-only)
18. Reuse the shared record controller, capability reasons, approvals and structured-value/matrix
    renderers. Related edits are explicit admitted operations, preserving filtered and unloaded
    children; template UI does not implement its own grants, status engine or approval flow.
    [app-structure](app-structure.md#inline-related-information)
19. For a table's New action within a parent record, use `toolbar.new` with a native `Sheet` and
    `RecordShell mode="create" values={{ parent_id: parent.id }}`. The fixed `where` scopes the
    table read; supply create values explicitly. Reuse the model representation and native
    controller, and close the create sheet on a committed or `pendingApproval` outcome. Verify
    the resulting foreign key and persisted record through the actual UI.
