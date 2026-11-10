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
| `state` | `initial`, `states: { s: { to, edit } }`: a lifecycle that also owns editable fields |
| `seq` | patterned number, never reused; `{yyyy}` in the workspace zone at commit; `per` scope |
| `sum`, `count` | roll-ups through a relationship's `inverse`, optional `where` |
| `json` | typed by `shape`, the same literal language |
| `file` | `accept`, `max` up to 20 MiB, `multiple` up to 20 files |
| `point` | `{ lat, lng }`; keep an address in a text field |
| `vector` | `dim` up to 2000, `metric` |
| `custom` | `of`: a workspace custom field, or built-in money, file, point, phone |

- Common keys: `optional default unique label help hidden`; `was` keeps data through a rename.
- Date and instant defaults may be `{ var }` clock expressions, evaluated at write time. A ref default may be `{ var: 'requestor.id' }` or `{ var: 'requestor.party' }`. Read predicates hold no time variables.
- Inputs (automations, integration records, json shapes, custom fields) also admit number, id, union and record. One declaration types the stored row and every input.
- System columns `id revision created_at created_by updated_at updated_by` are not field names.

## Record identifier

- `record_label` is optional pure CEL over own stored, computed or nested inline values: no cross-record lookups or clocks. Use conditionals for optional values and `string(value)` for numbers.
- The engine materializes and indexes it and rebuilds it on change. Sheets, table titles, pickers, references, search and approvals reuse it. Outputs must expose its dependencies.
- Without it consumers show the record UUID, and search needs `search.text`. Never add a duplicate title field.

## Relations and layers

- A foreign key is a field with `{ kind: 'ref', to, inverse }` and optional `optional`, `owned`, `on_delete`, `where` and `default` settings. A list in `to` declares a polymorphic ref. A model with two refs represents a many-to-many relation.
- `on_delete` accepts `restrict` by default, `cascade`, or `set_null` for optional refs. Owned refs cascade.
- `key` is the natural key imports match. Named `constraints` enforce uniqueness and checks, guard periods with `no_overlap` and declare locks with `locked`. A lock can list editable fields in `except`. `computed` holds typed expressions over own fields. A value needing I/O or hashing is a stored field set by a callback or automation.
- Each output is a tree with `fields` and one nested key per relation. Declaring `outputs.default` exposes the model as a read root.
- `create.columns` and `update.columns` are layer maps keyed by path, up to five levels. Each write layer is a many-relation. The engine fills its parent FK. `create.filled` names columns the transform fills.
- Nothing is deleted by omission: an update names child changes per layer as `{ create, update, delete, link, unlink }`.
- Use named outputs for narrower audiences. Each layer of an output is visible to its readers under the root's policy.
- A layer is read or written under the root model's policy alone.
- A described filter reaches a related record by name through a layer of the caller's output. Declare `<ref>: { fields: ['name'] }` in an output when its holders can read the related name. A bare ref can be filtered by id or by `me`.

## Locks and moves

- A row matching `locked` refuses update and delete on every path, administrators included. It reads own direct fields only; a child needs its own lock.
- `enum.transitions`: a write outside them is refused and the editor offers only legal targets. Use `state` when the lifecycle owns editable fields.
- Never duplicate these rules in a transform, delete check or form.
- Approval is a separate lock, never a business state named approved.

## Write callbacks

- A create transform gets all rows, each with the `id` it will have; an update transform gets `{ before, set }` per row and returns sets; a delete check gets stored rows and only refuses.
- To write other models in the same transaction, return `{ rows, with, onApproved }` (a delete check `{ with, onApproved }`), each `{ [model]: { create?, update?: [{ target, set, observed? }] } }`. Carried rows run their own callbacks (`ctx.carried_by`); a stale `observed` is a conflict.
- `with` rows are part of the write: held, locked and rolled back with it. `onApproved` rows (ledger and balance postings) commit once it is approved, in the approving decision's statement, all or nothing.
- Under an approval the decision calls the callback again with `ctx.approving` on the stored rows; return only `onApproved`, and never count those rows twice.
- They run on every business write path: pages, agent, automations, syncs, imports, upserts, bulk edits, resubmits, restore, nested owned children. Children run after the parent. Seed restores and roll-ups bypass them.
- Keep semantic validators in browser-safe `src/lib` modules returning `{ field, message }`; forms and the server share them. Client validation never writes.
- Prefetch the batch through `ctx.query` as the workspace, at most two reads, never per row. The engine prefetches `before`, delete rows and upsert matches.
- Each 1000-row chunk has 3 s CPU and one callback per verb and model; all chunks share one transaction.

## Operations

- A model has only `create`, `update`, `delete` and keyed `upsert`, no named actions or queries. A computed read is one read request plus a pure helper.
- A business operation is an automation, `+<model>_<operation>.automation.ts`, with explicit IDs and typed input; a run has no implicit target. See [automations-and-effects.md](automations-and-effects.md).
- Every generated write takes an array. Independent writes that must commit together use `ctx.act.many`; dependent parent and child use write layers. A transform can carry related rows into the same commit.

## Search

- `search.text` takes own text, enum and patterned `seq` fields and links; a ref finds the row by the linked record's `search.text`, which `bolt check` requires. It turns on the toolbar search and the finder.
- `search.semantic` embeds; `search.indexes.<name>` holds `dim`, `metric`, `vector`, typed `input`, `probe`, optional `rerank`, `candidates` (multiplier 1 to 16).
- A vector callback is pure and returns a vector or null. I/O-derived vectors are written by an automation and named by the index.

## Syncs

Place exchange under `syncs.<name>`. Discover: `import('@norbital-ai/bolt').RemoteSync`, `FileSync`.

- Remote: `with: '<integration>'`, optional `every` and partitions, inline `read` and `write`. A read returns rows (`$id`, `$version`, `$deleted`), cursor and more; only returned source fields sync; page progress commits atomically. A write returns the acknowledged id and version, or null for local changes.
- The engine owns no-echo, ordering, idempotency, retries, approval timing, conflict rollback and dead letters. A failing read rests per connection, one minute doubling to one hour, until a manual start, connection change or good read.
- File: `with: 'file'`, `parser`, optional schema and context. Reads keep the caller's scope and outputs; remote syncs read as trusted workspace. Context never elevates authority.
- A file read gets records with `$at` positions and returns rows plus findings. A write returns records or `{ document: { html }, name }`. One refusal rolls back the file. A `txt` export concatenates columns with no separator.
- Custom parsers declare an IANA `type`, extensions and an inline generator. Remote data never uses a parser.

## Notices and documents

- `notify(event, ctx)` runs after commit, reads as workspace and returns notices (`title`, `to`, optional `via`, attachments, link, `once`). Write and approval events both arrive. Inbox is automatic; `via` names conversation connections.
- Declare converter targets in `+workspace.ts`. Page conversion is limited by the policy `convert` limit.

## Custom fields

- `custom_field(name, { description, shape, validate? })`; validation is inline and pure.
- The optional renderer gets `{ view }` (`CustomFieldView`) in show or edit mode; keep typed values through `onChange`.
- Renderers apply everywhere the kind shows and bundle statically: keep them light. Without one the shape supplies display and editing.
