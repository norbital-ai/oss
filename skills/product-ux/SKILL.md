---
name: product-ux
agent: true
authoring: true
description: How a workspace's apps, pages and record representations should be composed.
---

1. Compose from the shell, layout and view primitives; a page root is never raw markup. Read a page or layout reference only for what the authoring primer leaves open.
2. Organize apps by user workflow (typically operations vs configuration), never one page per model. Every model has one primary home; owned children live inside their parent's hub.
3. The shell owns the page. A page with more than one section scrolls inside its shell, never on the browser body.
4. Match each record's representation to its data shape: use multi-column grids (`Grid`, 2–3 fields per row) for compact attributes, timelines for dated series, board + table switchers for workflow stages, and scoped summary strips or charts for quantitative trends. For polymorphic models, use a step-based or discriminator-first form that chooses the variant before revealing only that variant's fields. Give every record model a representation; use native views before custom components and never render a model as ad-hoc markup.
5. Avoid overloading any view — a view being an app page, an app tab's content, or a tab/panel inside a record representation. Place at most one `Table` or `Board` per view; separate distinct lists into their own tabs, group form fields by meaning into sections, collapse secondary metadata with a summary, and never repeat header or summary values in the body or across tabs.
6. One scroll owner per region. Never nest scrolling containers on one axis.
7. A table or board fills its parent region and scrolls inside itself; it never makes its parent overflow. Only when the parent's available height is below its minimum height may it exceed it, and then the parent scrolls.
8. Keep tab hierarchies flat: use toolbar view controls only to switch views of the same model (e.g. table, board, timeline), and give distinct child models or concerns their own tabs. When nesting is unavoidable, tabs step down by level (default, underline, chips), and deep or wide sets take vertical tabs on the left.
9. The simplest, most general layout that serves the job is the better one: fewer pages, fewer components.
10. Artwork is part of the app identity: a banner or thumbnail is a real image with a working source and alt text, never a placeholder.
11. Verify in the preview: pages render, scroll, and show no broken images or console errors.
