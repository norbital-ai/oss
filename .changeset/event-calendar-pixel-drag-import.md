---
'@norbital-ai/ui': patch
---

Fix the day and week calendar views importing `#lib/utils/pixel-drag.js` with an extension the `#lib/utils/*` subpath appends itself, which resolved to `pixel-drag.js.js` and failed any build that reached the event calendar.
