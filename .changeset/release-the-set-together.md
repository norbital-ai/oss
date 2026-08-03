---
'@norbital-ai/config': patch
'@norbital-ai/std': patch
'@norbital-ai/ui': patch
---

Release the five packages as one set, so no template pins a mix.

`config`, `std` and `ui` carry no source change in this release. They are versioned anyway because a
template pins every first-party dependency exactly and exempts each pinned version from the
release-age delay by name — a partial bump would leave a template straddling two release sets, which
is the state those two mechanisms exist to make impossible to enter by accident.
