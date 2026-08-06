---
'@norbital-ai/std': minor
---

Add the `@norbital-ai/std/i18n` entry point: a typed message catalog, interpolation, and locale
detection/persistence shared by the pod shell and the UI package. Both now import it, so it has to
be published as part of the same release rather than resolved from the workspace.
