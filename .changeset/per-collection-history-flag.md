---
'@norbital-ai/platform-utils': minor
'@norbital-ai/pod': minor
---

Let a collection declare whether it keeps temporal history, and drop the relation when it stops.

Which tables get a `<name>_history` relation used to be a hardcoded list inside the migration
generator, and a differently-scoped list inside the runtime post-DDL. The two disagreed the moment
one moved: adding the agent transcript tables to the generator's list stopped column changes being
mirrored into history relations the migration lineage still declared, and nothing ever dropped
them, so the lineage described two relations that had to evolve together while only one did.

`history` is now an option on the collection definition itself — `history?: boolean` on
`ModelMetadata` for a tenant collection and on `SystemTableMeta` for a system one — defaulting to
true. Both the generator and the post-DDL read that one flag, the generator by importing the model
that declares it and the post-DDL through the manifest it is published into, so neither can decide
a collection is temporal while the other decides it is not. Opt out for a high-volume, append-only
collection whose rows are already ordered by their own sequence, where the history row roughly
doubles the write cost of every insert to buy a revision trail nothing reads.

Turning it off is now a schema change like any other. The generator replays the lineage to work out
which history relations are live, and emits a guarded drop for any whose record table is no longer
temporal — including into a migration of its own when the flip is the only change, since a change
drizzle cannot see would otherwise succeed while doing nothing. `chat_session`, `chat_turn`,
`chat_message` and `audit_event` carry the flag, and the templates carry the drop.

The post-DDL's history refresh also stops exempting every system collection. It only ever needed to
skip the ones without history, and the collections that do have one — most of them — were silently
outside the drift repair that keeps a history relation in step with its table.
