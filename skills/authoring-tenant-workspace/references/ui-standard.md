# Template UI standard

Checks every template page passes. Rule homes: [app-structure.md](app-structure.md), [layout-and-scrolling.md](layout-and-scrolling.md), [typography.md](typography.md), [controller-surfaces.md](controller-surfaces.md).

1. A page is an `AppShell` around one view: icon, 1 to 3 word title, one-sentence description up to 90 characters with a final period.
2. An app's name never repeats the workspace name; the app icon is the header icon.
3. One concern per view (app page, app tab, or representation tab): at most one `Table` or `Board` per view; tab title equals view title; one tab size.
4. The toolbar is fixed; no button above, beside or in a view header.
5. Two scaffolds only. Record (`RecordShell`: header, body, one footer) for any view that shows or edits one record, settings and singletons included; app (`AppShell`: app header and tabs, the table or `CustomView` toolbar, body) for lists, boards, dashboards, reports, dispatch and portals, with filters and report parameters in its toolbar or body. No third frame of its own header and footer. Record sheet: title `record_label` or UUID, overline the singular model label, subtitle fields; one primary action, the rest in overflow. `RecordShell` always owns the visible header/footer and scrolling body, including custom representations; authors decorate its footer rather than opt into one.
6. A row click opens that row's record and nothing else: no link, relation link or inspect popover in a cell. A row that stands for another record (a report line, a snapshot item) opens it with `on_open`. Row operations are row `actions`, never loose buttons in cells.
7. Labels use the native catalog conventions and humanized fallback; put meaningful wording overrides in the catalog.
8. Kinds carry meaning: `date`, `instant`, `money`, `decimal`, `int`, `currency`, markdown; no hand-written formatting. Controlled `<Table of={rows}>` columns must declare `kind` (`date`, `instant`, `money`, `decimal`, `int`) and `align: 'end'` on numeric/money fields, render enums/states with `Badge`/`StateBadge`, and merge currency + amount into one `kind: { kind: 'money', currency: '...' }` column — never raw enum codes, raw ISO dates, or split `Currency` + `Amount` columns.
9. The kit formats: date medium; instant medium with short time; money `CODE 1,234.00`; decimals trimmed; empty `—`.
10. A state is a coloured badge; an enum or tag is a neutral chip.
11. Empty and loading are the kit's `EmptyState` and the view's skeleton.
12. Submit reads "Save" or the action's verb; required comes from the model and help from the catalog. One view, one Save: its edits commit through one footer action; sections, collapsibles and tabs carry none. Other writes ride the `Form`'s `acts`; a separate action opens its own sheet. Settings and singleton records edit in `RecordShell` too; no bare page-level `Form`.
13. Layout only through primitives and typography roles; one view per scroll.
14. A regional `locale` and `tz`; base and `zh` catalogs cover every visible string; check phone width with a finger: every widget reflows, and the kit's own do (table rows, forms two fields to a row, calendar days over an agenda). A hand-built widget states its own small-screen layout.
15. Disclosure supports the task: primary inputs visible, consistent field order across create, edit and read.
16. Every chart answers a stated decision.
17. Reuse the record controller, capability reasons, approvals and structured renderers; related edits are explicit operations preserving unloaded children.
18. A table's New inside a parent record uses `toolbar.new` with a native `Sheet` and `RecordShell mode="create"` carrying the parent in `values`. `where` scopes the read only. Close on committed or `pending_approval`. Verify the foreign key through the real UI.
19. One chromatic action per view: `Button variant="brand"` at most once; the workspace brand colour is never decoration. Shared theme overrides belong in `+workspace.ts`, not page-specific CSS.
20. Surfaces separate with hairlines: `border border-border` on `bg-card`. Cards 12px maximum, controls 6px, badges 4px, pills round. No `shadow-card`, glow or 16px+ radius.
21. View navigation and scope: use `Tabs` (level 2 inside a tabbed page) to switch views or sub-reports — never `<Combobox>` or `<select>` in the body or toolbar. Reserve `AppShell.actions` strictly for page-wide scope selectors (period, legal entity) that govern every tab on the page.
22. Inputs and control sizing: every input carries a visible label (never placeholder-only), and raw `<select>` is banned (use `Combobox`/`Select`). Controls size from their parent layout (`Grid`, `Inline`, `Stack`, `Cluster`), never fixed self-sizing classes (`w-*`, `h-*`, `w-[…]`, `h-[…]`, `min-w-*`, `min-h-*`) on `Input`, `Combobox`, `TimeInput`, or `Bound`.
23. Summary and chart restraint: cap summary strips at 4–5 headline KPIs, omitting zero-value breakdown tiles, orphan rows, and tables or metrics owned by another page or tab. Never wrap `<Chart>` in `<Bound size="viewport">` — size charts to a bounded panel height (`~16–20rem`) so surrounding content stays scannable.
24. Icons and workflow CTAs: use Lucide icons (never raw indicator glyphs such as `▲`, `▼`, `ℹ`, `⚠`). Surface a view's primary state and next workflow action directly (`Badge`/`StateBadge` + the one `Button variant="brand"`), never hidden inside the `⚡` toolbar menu.
