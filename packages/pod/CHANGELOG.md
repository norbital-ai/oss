# @norbital-ai/pod

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
