---
name: data-modelling
description: Modelling a workspace's data in Bolt - models, field kinds, links, read and write layers, state, invariants, search, custom types and migrations.
---
## Decide the models
A model is a table people work on: model('<name>', { description, icon, label, fields, … }). Prefer fewer models: a
value its parent owns, with no identity, lifecycle, permissions, history or relational query of its own, is an inline
typed value (json with a shape, or a custom field type). Business variation that people configure (rates, catalogues,
rules) is records; source defines the language and the rules that run them.

## Fields
text (format email | phone | url | markdown | zone; many), int, number, decimal, money (every amount; its currency),
bool, date, instant, time, duration, period (an effective range), enum (values; transitions), state (initial and
states, each { to, edit }: the record's lifecycle; it moves only along its edges and edit says what stays editable),
seq (a patterned number per scope), file (many), point, json with shape (object, list, record, union), and custom
field types (data/custom_field/<name>/+definition.ts, a shape and validation, optional renderer). Each takes optional,
default, unique, label, help, hidden; `was` keeps data through a rename. label names the fields a row reads as
(never an id or a link).
A link is a ref field { kind: 'ref', to, inverse, optional?, onDelete?: restrict | cascade | setNull, owned? }: the
other model reads the inverse as a many-relation. An owned child is created and deleted through its parent.

## Reads, writes and authority
read is the layer map callers may read: { <model>: { fields }, '<model>.<relation>': { fields } }. create, update,
delete and upsert take columns per layer (nested children through their relation), a transform to normalise or derive
values and a check for business rules; a batch commits whole. Models have no named actions: a business operation is
an automation with typed inputs and start grants (runAs: 'trigger' keeps its starter's authority). Policies grant
reads (rows by where, fields), write columns and a check that allows, denies or routes the batch to an approval flow.

## Invariants belong to the model
check ({ name: { where, message } }), locked (rows read-only by a predicate), noOverlap (a key and a period), state
edges, unique fields and table indexes are enforced by the database for every writer; computed fields are stored
expressions over a row's own fields. Use them before callback code, and never repeat them in a page.

## Search
search.text lists own text, enum and patterned seq fields, and links: a link finds the row by the linked record's own
search text (an entry by its person's number or name). Declaring it turns on the toolbar search and the finder.
search.semantic embeds text or file fields for meaning search; search.indexes holds custom vector indexes.

## Seeds and migrations
Seed packs carry public base data and private samples; never seed authority, credentials or envoys. The manifest is
the schema: the preview build generates the next migration, replays it and commits it to the change; review its
destructive steps (a merge lists them). For a complex data pattern, edit that unapplied migration's SQL (a data UPDATE
that skips rows already transformed); the next build replays it and refuses any result that differs from the schema.
Never edit a migration live has applied. `-- check: <name>` then one select whose rows are violations proves the
data after the steps; any row rolls the file back. When the person asks to tidy a long history, preview with squash.
