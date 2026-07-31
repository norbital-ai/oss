---
'@norbital-ai/pod': patch
---

Remove the sync engine's remaining compatibility paths and the gaps they were hiding.

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
