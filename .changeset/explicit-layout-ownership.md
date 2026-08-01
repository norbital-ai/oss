---
'@norbital-ai/ui': patch
---

Keep growth, fill, shrink, centring, direct-child arrangement, and scroll ownership on the layout
primitives that implement them. Collection, calendar, editor, and shell surfaces no longer override
those contracts with utility classes, preventing phantom table space, collapsed bodies, and nested
scroll regions.
