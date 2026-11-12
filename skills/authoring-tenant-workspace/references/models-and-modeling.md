# Models and modeling

Every field is required unless `optional: true`. Exact shape: `import('@norbital-ai/bolt').ModelLiteral`, `FieldKind`.

## Field kinds

| Kind | Rule |
| --- | --- |
| `text` | `format`: email, phone, url, zone, markdown, cel; `many`. Email compares case-folded |
| `int`, `number`, `decimal`, `money` | decimal and money are exact, never floats; money rounds to its currency's minor unit, `scale` keeps more |
| `currency`, `bool` | |
| `date`, `instant`, `time`, `duration`, `period` | see [dates-and-time.md](dates-and-time.md); an `instant` named `*_on` or `*_date` is refused |
| `enum` | `values`, `many`, `transitions` |
| `state` | `initial`, `states: { s: { to, stamp? } }`; declare editable exceptions in a named lock constraint |
| `seq` | patterned number, never reused; `{yyyy}` in the workspace zone at commit; `per` scope |
| `sum`, `count` | roll-ups through a relationship's `inverse`, optional `where` |
| `json` | typed by `shape`, the same literal language |
| `file` | `accept`, `max` up to 20 MiB; `many: true` holds multiple files |
| `point` | `{ lat, lng }`; keep an address in a text field |
| `vector` | `dim` up to 2000, `metric` |
| `custom` | `of`: a workspace custom field, or built-in money, file, point, phone |

- Common keys: `optional default hidden`; `many: true` declares a list. `was` keeps data through a rename. Uniqueness belongs to named constraints. Captions and help come from the message catalog; declaration fields refuse inline `label` and `help`, including nested input and output kinds.
- Date and instant defaults may be `{ var }` clock expressions, evaluated at write time. A ref default may be `{ var: 'requestor.id' }` or `{ var: 'requestor.party' }`. Read predicates hold no time variables.
- Inputs (automations, integration records, json shapes, custom fields) also admit number, ref, union and record. One declaration types the stored row and every input.
- System columns `id revision created_at created_by updated_at updated_by` are not field names.

## Record identifier

- `record_label` is optional pure CEL over own stored, computed or nested inline values and one-hop to-one relations exposed by the default output. No clocks. Use conditionals for optional values and `string(value)` for numbers.
- The engine materializes and indexes it and rebuilds it on change. Sheets, table titles, pickers, references, search and approvals reuse it. Outputs must expose its dependencies.
- Without it consumers show the record UUID, and search needs a text entry under `indexes`. Never add a duplicate title field.

## Relations and layers

- A foreign key is a field with `{ kind: 'ref', to, inverse }` and optional `optional`, `owned`, `on_delete`, `where` and `default` settings. A list in `to` declares a polymorphic ref. A model with two refs represents a many-to-many relation.
- `on_delete` accepts `restrict` by default, `cascade`, or `set_null` for optional refs. Owned refs cascade.
- Named `constraints` enforce uniqueness and checks, guard periods with `no_overlap` and declare locks with `locked`. One unique constraint may set `import_key: true` for import matching. A lock lists editable fields in `except`. Computed fields carry their typed expression on `computed`. A value needing I/O or hashing is stored by a transform or automation.
- Each output is a tree with `fields` and one nested key per relation. Declaring `outputs.default` exposes the model as a read root.
- `create.columns` and `update.columns` are trees with root `fields` and one nested key per child relation, up to five levels. Each write layer is a many-relation. The engine fills its parent FK. `create.filled` uses the same tree for columns the transform fills.
- Nothing is deleted by omission: an update names child changes per layer as `{ create, update, delete, link, unlink }`.
- Use named outputs for narrower audiences. Each layer of an output is visible to its readers under the root's policy.
- A layer is read or written under the root model's policy alone.
- A described filter reaches a related record by name through a layer of the caller's output. Declare `<ref>: { fields: ['name'] }` in an output when its holders can read the related name. A bare ref can be filtered by id or by `me`.

## Locks and moves

- A row matching `locked` refuses update and delete on every path, administrators included. It reads own direct fields only; a child needs its own lock.
- `enum.transitions`: a write outside them is refused and the editor offers only legal targets. Use `state` for a stamped lifecycle and constraints for editable fields.
- Never duplicate these rules in a transform or form. Delete refusal belongs to the policy verdict or a named lock, not a delete transform.
- Approval is a separate lock, never a business state named approved.

## Write callbacks

- Create and update transforms get changes with `before`, `set`, `after` and `changed(...fields)`. A create's `after` carries its future id. Return sets in order, or `{ sets, with, on_approved }`; delete has no transform.
- `with` and `on_approved` hold `{ [model]: { create?, update?: [{ target, set }] } }`. Each target carries the selected revision; related rows run their own transforms (`ctx.carried_by`).
- `with` rows are held and rolled back with the root write. `on_approved` rows commit immediately when no approval holds the write, or once in the final approving decision's statement, all or nothing.
- The approving decision asks the transform again with `ctx.approving` on the stored rows; return only `on_approved` then and never count those rows twice.
- Transforms run on every business write path: pages, agent, automations, native sync/import matching, bulk edits, resubmits, restore and nested owned children. Children run after the parent. Seed restores and roll-ups bypass them.
- Keep semantic validators in browser-safe `src/lib` modules returning `{ field, message }`; forms and the server share them. Client validation never writes.
- Prefetch the batch through `ctx.query` as the workspace, at most two reads, never per row. `ctx.query.after` overlays this act's prospective rows for checks across the batch.
- Each 1000-row chunk has 3 s CPU and one callback per verb and model; all chunks share one transaction.

## Operations

- A model exposes `create`, `update` and `delete`; a unique constraint marked `import_key: true` provides native `import`, and file syncs provide file transfer. There is no public upsert or named model action. A computed read is one read request plus a pure helper.
- A business operation is an automation, `+<model>_<operation>.automation.ts`, with explicit IDs and typed input; a run has no implicit target. See [automations-and-effects.md](automations-and-effects.md).
- Every generated write takes an array. Independent writes that must commit together share one `ctx.act({ '<model>.<verb>': inputs })` map; dependent parent and child use write layers. A transform can carry related rows into the same commit.

## Search

- Named `indexes` entries declare `{ text: ['field'] }`, `{ semantic: { fields, model, dim } }`, physical `{ on: ['field'] }` or a custom vector index. Text indexes and record labels power toolbar and finder search.
- A custom vector entry holds `description`, `dim`, `metric`, `vector`, typed `input`, `probe`, optional `rerank` and `candidates` (multiplier 1 to 16).
- A vector callback is pure and returns a vector or null. I/O-derived vectors are written by an automation and named by the index.

## Syncs

Place exchange under `syncs.<name>`. Discover: `import('@norbital-ai/bolt').RemoteSync`, `FileSync`.

- Remote: `with: '<integration>'`, optional `every` and partitions, inline `read` and `write`. A read returns rows (`$id`, `$version`, `$deleted`), cursor and more; only returned source fields sync; page progress commits atomically. A write returns the acknowledged id and version, or null for local changes.
- The engine owns no-echo, ordering, idempotency, retries, approval timing, conflict rollback and dead letters. A failing read rests per connection, one minute doubling to one hour, until a manual start, connection change or good read.
- Local changes fan out to every active account of that integration, including changes imported from another account. Do not invent a per-row connection selector.
- File: `with: 'file'`, `parser`, optional schema and context. Reads keep the caller's scope and outputs; remote syncs read as trusted workspace. Context never elevates authority.
- A file read gets records with `$at` positions and returns rows plus findings. A write returns records or `{ document: { html }, name }`. One refusal rolls back the file. A `txt` export concatenates columns with no separator.
- Custom parsers declare an IANA `type`, extensions and an inline generator. Remote data never uses a parser.

## Notices and documents

- A per-verb effect calls `ctx.notify({ title, to, via?, attachments?, link?, once? })` as its writer. Approval lifecycle details are in `ctx.event`; built-in inbox notices need no duplicate callback. `via` names persisted conversation accounts.
- Declare converter targets in `+workspace.ts`. Page conversion is limited by the policy `convert` limit.

## Custom fields

- `custom_field({ description, shape, validate? })`; the file supplies its name and validation is inline and pure.
- The optional renderer gets `{ view }` (`CustomFieldView`) in show or edit mode; keep typed values through `on_change`.
- Renderers apply everywhere the kind shows and bundle statically: keep them light. Without one the shape supplies display and editing.
