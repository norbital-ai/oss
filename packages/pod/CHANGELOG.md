# @norbital-ai/pod

## 0.0.13

### Patch Changes

- 0ed8ab6: Fix `Cover`, and make `Stack` able to express what callers were writing as classes.

  `Cover` built its grid rows as ``class={`[grid-template-rows:${rowTemplate}]`}``. Tailwind emits CSS
  by scanning source text, so a class assembled at runtime names a rule that was never generated —
  `Cover` rendered as a bare `grid` with implicit auto rows, which distributes rows evenly. It
  presented as three unrelated bugs: a page header that would not stay at the top, a body that would
  not take the remaining height, and a dialog footer that would not pin to the bottom. A single record
  in a collection table sat centred with equal bands above and below, which read as a phantom row. The
  row template is now an inline style, which Tailwind does not compile and therefore cannot drop.

  `Stack` gains `align`, `justify`, `grow` and `fill`. It had no way to place its children, so every
  caller wrote `flex-1 items-center justify-center` — and against a parent whose height comes from
  `min-h-*` rather than a definite height, that silently does nothing and the content stays at the top.
  The scanner now treats those classes on a primitive as an override (`UI10`), which was only fair once
  the props existed.

  An organization switch evicts the workspace instead of covering it. The request has to reach the
  host, the host has to warm the target runtime, and only then does the document navigate; for that
  whole window the previous organization's records stayed mounted under a translucent overlay and were
  still legible beneath the new organization's name.

  `Center` gains `measure="narrow"`. A login card or a single form has no measure to ask for between
  `reading` and the full width, so call sites wrote `mx-auto max-w-lg` and rebuilt `Center` by hand.

- c4ed91d: Render streamed markdown one block at a time, and keep the organization-switch module runtime-free.

  `ReadonlyMarkdown` put the whole document through a single `{@html}`. `{@html}` cannot patch — it
  assigns `innerHTML` — so every chunk of a streaming assistant message discarded and rebuilt every
  node in that message, and the browser re-laid-out and repainted all of it. Parsing was never the
  cost (marked is under a millisecond even at 14KB); the DOM churn was, and it grew with the length of
  the message. Lexing still covers the whole document, so reference definitions and footnotes resolve
  exactly as before, but each top-level block is parsed and rendered on its own — an unchanged
  paragraph produces a byte-identical string, Svelte's equality check skips it, and only the block
  being written is rebuilt.

  `switchOrganization` no longer holds its own `$state`. Runes compile only in `.svelte`/`.svelte.ts`,
  so a plain module reaching for one throws at runtime while `svelte-check` stays quiet. The shell owns
  the flag instead, which is also what lets the switch contract be tested without a Svelte runtime.

- Updated dependencies [0ed8ab6]
- Updated dependencies [c4ed91d]
  - @norbital-ai/ui@0.0.13

## 0.0.12

### Patch Changes

- b5c5c22: Reload the workspace document after changing the active organization so Core serves the selected
  tenant's bundle, manifest, identity, and database as one coherent workspace.

  Complete the local-first sync contract with client-minted UUIDv7 creates, subscription-filtered
  streams, authorization scope resets, cursor-only progress frames, exact server/local search parity,
  and replica reset notifications.

- b5c5c22: Remove the sync engine's remaining compatibility paths and the gaps they were hiding.

  - `replicaEpoch` is now required. It is the only trustworthy proof that cached rows still describe
    the same database, so the watermark-comparison backstop it replaced has been deleted rather than
    kept alongside it.
  - The replica's bookkeeping tables are versioned instead of migrated column by column. A version
    mismatch discards the cache and catches up again, which removes the `ADD COLUMN` ladder and the
    chance of a half-shaped table.
  - A discarded replica no longer persists a zero cursor. Reading one back at boot made a brand-new or
    freshly reset device decline to seed its cursor from its own catch-up watermark, so the stream
    resumed from the start of the feed — a full replay per device.
  - Stream interest is explicit: an unsubscribed collection is never resolved or emitted, and an empty
    subscription list requests cursor progress only. Subscription changes coalesce before rotating the
    connection, so warming a whole workspace no longer spends the warm-up reconnecting.
  - A cursor frame that arrives after diffs in the same chunk now advances the cursor, so a command
    barrier settles on the sequence the server actually reported.
  - A queued mutation stores the row it replaced. A retry no longer re-derives its undo from a replica
    that already shows the mutation, so a rejected offline delete is restored instead of staying
    deleted locally forever.
  - Bulk deletes chunk under the bind-parameter ceiling, matching the upsert path.
  - `xid` is required on a diff, and the dead `?since=` stream parameter is gone.

  Collection-event automations now actually run. `{ trigger: { collection, event } }` was declared,
  typed and compiled but nothing drained the change feed, so it never fired. The runtime exposes the
  drain, it advances a durable cursor so effects are exactly-once across restarts, and the standalone
  host drives it on every scheduler sweep.

  CRM's onboarding automation welcomes the new user, which gives the notification path an authored
  caller.

- Updated dependencies [b5c5c22]
- Updated dependencies [89ca704]
  - @norbital-ai/ui@0.0.12
  - @norbital-ai/platform-utils@0.0.12

## 0.0.1

- Initial public release of Pod as a precompiled, Core-agnostic Svelte runtime for plain Vite
  tenant workspaces.
- Replaced the Pod CLI, SvelteKit routes, adapter, configuration, and remote-function runtime with the `pod()` Vite plugin and Pod-owned HTTP runtime.
- Made `svelte`, `zod`, `runed`, `@iconify/svelte`, and `vite` direct workspace peer dependencies. Pod no longer publishes peer-package gateways.
- Moved app discovery, client/server bundling, migration generation, runtime host generation, Tailwind integration, and base CSS wiring into the Vite plugin.
- Preserved optional IFC viewing behind a lazy client boundary so construction workspaces do not compile the viewer stack into their initial application path.
