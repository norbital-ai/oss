# @norbital-ai/config

## 0.0.4

### Patch Changes

- Release the five packages as one set, so no template pins a mix.

  `config`, `std` and `ui` carry no source change here. They are versioned anyway because a template
  pins every first-party dependency exactly and exempts each pinned version from the release-age delay
  by name — a partial bump would leave a template straddling two release sets.

## 0.0.3

### Patch Changes

- a1f5eae: Release the five packages as one set, so no template pins a mix.

  `config`, `std` and `ui` carry no source change in this release. They are versioned anyway because a
  template pins every first-party dependency exactly and exempts each pinned version from the
  release-age delay by name — a partial bump would leave a template straddling two release sets, which
  is the state those two mechanisms exist to make impossible to enter by accident.

## 0.0.2

### Patch Changes

- ab72b9c: Move `config` with the rest of the set.

  `config` has no change of its own in this release. It is bumped anyway because the five packages are
  released together: a template resolves them as one set, and letting one lag leaves templates pinning
  a mix of release lines, which is the state that makes a later "why is this template on an older
  `platform-utils`" investigation necessary.

## 0.0.1

- Initial public release.
