---
'@norbital-ai/config': patch
---

Move `config` with the rest of the set.

`config` has no change of its own in this release. It is bumped anyway because the five packages are
released together: a template resolves them as one set, and letting one lag leaves templates pinning
a mix of release lines, which is the state that makes a later "why is this template on an older
`platform-utils`" investigation necessary.
