---
'@norbital-ai/ui': patch
---

Keep growth, fill, shrink, centring, direct-child arrangement, and scroll ownership on the layout
primitives that implement them. Collection, calendar, editor, and shell surfaces no longer override
those contracts with utility classes, preventing phantom table space, collapsed bodies, and nested
scroll regions. Collection tables now apply their container-query visibility rules to the actual
wide and narrow child roots, so only one responsive representation is painted at a time.
