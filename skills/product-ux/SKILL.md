---
name: product-ux
agent: true
authoring: true
description: How a workspace page and form should be composed.
---

1. Compose from the shell, layout and view primitives; a page root is never raw markup. Read a page or layout reference only for what the authoring primer leaves open.
2. The shell owns the page. A page with more than one section scrolls inside its shell, never on the browser body.
3. Reveal detail progressively: group a form's fields by meaning into sections, never one long flat list.
4. Records show in the native views (table, board, chart) and the record sheet for one row; give every record model a representation. Use them before any custom component, and never render a model as ad-hoc markup.
5. One scroll owner per region. Never nest scrolling containers on one axis.
6. A table or board fills its parent region and scrolls inside itself; it never makes its parent overflow. Only when the parent's available height is below its minimum height may it exceed it, and then the parent scrolls.
7. Tabs follow their nesting level: the first level is default tabs, the second underline, the third chips. Many sections or deep nesting take vertical tabs, always on the left, never the right; otherwise horizontal.
8. The simplest, most general layout that serves the job is the better one: fewer pages, fewer components.
9. Artwork is part of the app identity: a banner or thumbnail is a real image with a working source and alt text, never a placeholder.
10. Verify in the preview: pages render, scroll, and show no broken images or console errors.
