---
'@norbital-ai/platform-utils': minor
'@norbital-ai/std': minor
'@norbital-ai/pod': patch
---

The seed executor now refuses a payload key it cannot account for, instead of dropping it silently.

`seedTemplateDataFromPlan` used to filter every payload down to the target table's columns and
insert what survived, so a key that was not a column simply never landed and the row seeded looking
populated while the column stayed NULL. That behaviour shipped three defects in one week, including
a seed that wrote `user_name` instead of `name` — every seeded user got a NULL name and nobody could
sign in to a fresh tenant, with the seed reporting success throughout.

A payload key must now be a column, a relationship key the executor's second pass consumes, or a
declared sidecar. Anything else aborts the whole plan before the first write (including before
`clearBefore` deletes), naming the step, the table, the key, how many rows carry it, and the closest
real column.

**Migration.** Callers that consume a payload key themselves before seeding — Core's
`seedDocumentAssets` reads `document_asset.metadata.seed_asset` — declare it via the new
`sidecarKeys` input as `{ collection: { key: 'why it is consumed before execution' } }`. The reason
is required and is printed in the seed log on every run. Everything else that trips the check is
drift and should be fixed in the seed.

Also: `CompiledSeedPlan` mutations now carry the optional `step_id` they were compiled from, so the
executor can name the step; `SeedExecutionPlan` is an alias of `CompiledSeedPlan` rather than a
second copy of the same shape; and `@norbital-ai/std/string` exports `editDistance` and
`nearestName`, the shared "did you mean" helper now used by both the compiler's orphaned-role
diagnostic and this check.
