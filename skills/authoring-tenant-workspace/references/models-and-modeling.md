# Models and modeling

A model is an entity's stored and exposed contract. Declare it as `model('orders', spec)` in
`src/data/model/orders/+model.ts`; its optional `+representation.svelte` lives beside it. Policies,
reads, pages, automations, agents and seeds name the model. Prefer inline shaped values unless
identity, lifecycle, authority, history or relational queries justify another model; see
[model boundaries](model-boundaries.md).

## Field kinds

Every field is required unless it says `optional: true`. Use the installed kind declarations as the exact API:

| Kind                          | Literal                                                                                                | Notes                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text                          | `{ kind: 'text', format?: 'email' \| 'phone' \| 'url' \| 'zone' \| 'markdown' \| 'cel', max?, many? }` | `eq`/`in` on an email compare case-folded; `markdown` is prose (notes, terms) shown formatted; `cel` is a CEL expression, edited and shown as wrapped code, in a json `shape` too (never a local code editor) |
| int                           | `{ kind: 'int', min?, max? }`                                                                          |                                                                                                                                                                                                               |
| decimal                       | `{ kind: 'decimal', scale, precision?, min?, max? }`                                                   | a `Decimal` value (`@norbital-ai/std/decimal`), never a float                                                                                                                                                 |
| money                         | `{ kind: 'money', currency?: CurrencyCode \| FieldName, scale? }`                                      | rounds to the currency's minor unit; `scale` keeps more places (a unit price at 4)                                                                                                                            |
| currency, bool                | `{ kind: 'currency' }`, `{ kind: 'bool' }`                                                             |                                                                                                                                                                                                               |
| date, instant, time, duration | `{ kind: 'date' }` …                                                                                   | a calendar day is `date`: `bolt check` refuses an `instant` named `*_on` / `*_date`; see [dates-and-time.md](dates-and-time.md)                                                                               |
| period                        | `{ kind: 'period', of: 'date' \| 'instant' }`                                                          | date: `{ from, to \| null }` inclusive; instant: `{ start, end \| null }` half-open                                                                                                                           |
| enum                          | `{ kind: 'enum', values: [...], many?, transitions? }`                                                 | `transitions` declares the valid state moves; a write outside them is refused                                                                                                                                 |
| state                         | `{ kind: 'state', initial, states: { s: { to?, edit? } } }`                                            | a lifecycle that also owns which fields `edit` admits                                                                                                                                                         |
| seq                           | `{ kind: 'seq', pattern?: 'PO-{yyyy}-{0000}', per? }`                                                  | never reused; `{yyyy}` in the workspace zone at commit                                                                                                                                                        |
| sum, count                    | `{ kind: 'sum', of: 'lines.amount', where? }`, `{ kind: 'count', of: 'lines', where? }`                | roll-ups through a relationship's `inverse`                                                                                                                                                                   |
| json                          | `{ kind: 'json', shape?: InputKind }`                                                                  | typed by the same literal language                                                                                                                                                                            |
| file                          | `{ kind: 'file', accept: ['image/*'], max: '10MiB', multiple? }`                                       | ≤ 20 files, `max` ≤ 20 MiB                                                                                                                                                                                    |
| point                         | `{ kind: 'point' }`                                                                                    | `{ lat, lng }`; works with no geocoder; keep an address in a text field beside it                                                                                                                             |
| vector                        | `{ kind: 'vector', dim, metric: 'l2' \| 'cosine' \| 'ip' }`                                            | HNSW index, `dim` ≤ 2,000                                                                                                                                                                                     |
| custom                        | `{ kind: 'custom', of: '<f>' }`                                                                        | a workspace custom field (below), or a built-in: `money`, `file`, `point`, `phone`                                                                                                                            |

Common keys are `optional default unique label help hidden`. Defaults are typed literals; a date
default may be `{ var: 'today' }` or `{ var: 'today + days(7)' }` (days or weeks), an instant default
`{ var: 'now' }` or `{ var: 'now - hours(1)' }`, evaluated at write time; a ref default is
`{ var: 'requestor.id' }` (a `sys_user` ref) or `{ var: 'requestor.party' }`, filled from the writer.
Read predicates never contain time variables.

Structured stored values use list/object or a json shape. Inputs (automations,
integration records, json shapes and custom fields) additionally admit number (a finite double),
id (of, optional where for pickers), union (by + arms) and record. One declaration types both
the stored row and every input: `ValueOf<K>`, `InputOf<{…}>`.

## Relations and exposure

A foreign key is a field: `{ kind: 'ref', to: 'customers', inverse: 'orders' }`. Options include
`optional`, `owned`, `onDelete`, `where` and `default`. `to: ['customers', 'suppliers']` declares a
polymorphic arc; a many-to-many link is another model with two refs. The model's `key` names its
natural key, `unique` and `check` enforce static invariants, `noOverlap` guards periods, and
`computed` holds typed expression trees over its own fields. A computed value needing I/O,
JSON-path logic or hashing is an ordinary stored field derived by a write callback or automation.

`read`, `create.columns` and `update.columns` are layer maps keyed by path: `'orders'` is the root,
`'orders.customer'` and `'orders.lines'` the relations under it (a ref, an inverse many-relation or
an owned child), `'orders.lines.product'` one deeper, at most five levels, each parent declared too.
`read: 'all'` is `{ orders: { fields: 'all' } }`; a field list narrows a layer. A model without
`read` is no read root but can be another model's layer. A write layer is a many-relation and never
lists the FK tying the child to its parent; `create.filled` names columns the transform fills.
A delete may supply a `check`. Omitted write exposure makes that verb unavailable. Nothing is
deleted by omission: an update names child changes per layer as
`{ create, update: [{ target, set }], delete, link, unlink }`. `bolt check` (`model/layer`) proves
every path, field and column.

```ts
read: {
  orders: { fields: ["number", "customer", "status", "total"] },
  "orders.customer": { fields: ["name", "code"] },
  "orders.lines": { fields: ["product", "quantity", "net"] },
},
// named outputs beside `default` (never named `default`): a narrower audience's fixed shape
outputs: {
  logistics: { orders: { fields: ["number", "status"] }, "orders.lines": { fields: ["product", "quantity"] } },
},
create: { columns: { orders: ["customer", "notes"], "orders.lines": ["product", "quantity", "net"] } },
update: { columns: { orders: ["status", "notes"], "orders.lines": ["quantity", "net"] } },
```

`read` is the `default` output; `outputs` are the others. Every read names one output (`output`,
`default` when absent) and reads only its layers and fields. A policy grants outputs and filters
their rows; it never changes a shape, so an audience that must see fewer fields reads a narrower
named output. Authority is per access point: a layer is read or written under the root model's
policy alone, never the related model's. Each new layer of an output is visible to every reader of
that output unless the root's policy filters its rows.

## Locks and state moves

Declare immutability on the model, not in callbacks:

```ts
export default model('loans', {
	// ...
	locked: { settled_at: { notNull: true } }
});
```

A row matching `locked` refuses update and delete through every write path, administrators
included. The generated record page shows a lock with the reason instead of Edit; the server
refuses a write even when a custom page or automation tries it. The predicate reads the model's
own direct fields only; a relation's lock does not flow into its children unless the child model
declares its own. This is application-layer policy, never a database permission.

An `enum` field may declare `transitions`:

```ts
status: {
  kind: "enum",
  values: ["draft", "placed", "cancelled"],
  default: "draft",
  transitions: { draft: ["placed", "cancelled"], placed: ["cancelled"], cancelled: [] },
}
```

The host refuses a write that names a target outside the current value's list, and the enum editor
offers only those targets plus the current value. Use `state` instead when the lifecycle also owns
which fields each state may edit. Never duplicate either rule in `update.transform`, a delete
check, or a custom form.

## Write callbacks

```ts
export default model('orders', {
	description: 'Customer orders.',
	label: 'number',
	fields: {
		number: { kind: 'seq', pattern: 'SO-{yyyy}-{0000}' },
		customer: { kind: 'ref', to: 'customers', inverse: 'orders' },
		status: { kind: 'enum', values: ['draft', 'placed'], default: 'draft' },
		placed_at: { kind: 'instant', optional: true },
		notes: { kind: 'text', optional: true }
	},
	read: 'all',
	create: {
		columns: { orders: ['customer', 'notes'] },
		transform: function* (rows, ctx) {
			if (rows.some((r) => r.notes === ''))
				return yield* ctx.refuse('Notes cannot be blank.', { field: 'notes' });
			return rows;
		}
	},
	update: {
		columns: { orders: ['status', 'notes'] },
		transform: function* (changes, ctx) {
			return changes.map(({ before, set }) =>
				set.status === 'placed' && before.status === 'draft' ? { ...set, placed_at: ctx.now } : set
			);
		}
	},
	delete: {
		check: function* (rows, ctx) {
			if (rows.some((r) => r.status === 'placed'))
				return yield* ctx.refuse('A placed order cannot be deleted.');
		}
	}
});
```

A create receives all rows to insert. An update receives `{ before, set }` per row and returns the
sets. A delete check receives stored rows and only refuses. All callbacks run on every business
write path: pages, agent, automations, syncs, imports, upserts, bulk edits, resubmits,
restore and nested owned children. Children run their own callback after the parent. Seed restores
and derived roll-ups bypass callbacks. Share pure business helpers between verbs when needed.

Prefetch the whole batch through `ctx.db.query` as the workspace, with at most two reads. One read
request may gather several roots and their declared layers in one statement. Never read per
row. The engine prefetches `before`, delete rows and upsert matches. Each 1000-row chunk has its
own 3 s CPU budget and one callback per verb/model; all chunks remain in the import's one
transaction. Writes, history, roll-ups and approval locks are set-based, O(N/1000) statements.

Native defaults, checks, uniqueness, foreign keys and state triggers enforce the invariants the
schema can express. Declare ref `onDelete` as `restrict` (default), `cascade`, or `setNull` on an
optional ref; owned refs cascade. There is no public `onUpdate` option. Do not emulate these
referential actions with callback delete loops.

State `edit` and `to` rules hold on every path, administrators included. Approval is a separate
lock and request lifecycle, not a business state named approved. Policies enforce caller authority;
write callbacks supply business validation that the native schema cannot express.

## Computed reads and business operations

A model declares no named queries. A computed read is one read request plus a pure, browser-safe
`src/lib` helper that the page and server code both call; see
[data access](data-access.md#read-then-transform-in-srclib).

The model exposes only the standard guarded `create`, `update`, `delete` and keyed `upsert`
writes. A business operation is a named automation in `src/automation/+<model>_<operation>.automation.ts`:

```ts
import { automation } from '@norbital-ai/bolt';

export default automation('orders_duplicate', {
	description: 'Copy an order as a new draft.',
	input: { order: { kind: 'id', of: 'orders' } },
	policies: ['order_duplicating'],
	run: function* ({ order: id }, ctx) {
		const { orders } = yield* ctx.query({ orders: { where: { id: { eq: id } }, limit: 1 } });
		const order = orders.rows[0];
		const by = ctx.run.trigger;
		// only the starter's own orders: the trigger names them, the policies never do
		if (
			order === undefined ||
			by.kind !== 'person' ||
			by.actor.kind !== 'member' ||
			order.owner !== by.actor.id
		)
			return yield* ctx.refuse('This order is unavailable.');
		yield* ctx.act('orders.create', [
			{ customer: order.customer, notes: order.notes, owner: order.owner }
		]);
	}
});
```

Use explicit IDs and typed input; a run has no implicit target record. The run is the system
identity holding exactly its `policies`; `order_duplicating` grants the read/create its body needs.
Who started it is `ctx.run.trigger`, never authority: a rule about the starter ("only their own
orders") is an explicit check in the body, and refs the run writes are set explicitly. A person or the agent
starts it by hand through a held `policy.automations: ['orders_duplicate']`; code needs no start grant.
A page starts it with `bolt.start('orders_duplicate', { order: id })` and shows native run status.
Every generated write takes an array of rows. For independent writes that must commit together,
use one `ctx.act.many(...)`; dependent parent/child creates use the parent's write layers. Dependent reads and writes use
`ctx.transaction(function* (tx) { ... })`; see [the native transaction contract](data-access.md#write-a-record-and-what-belongs-to-it-together).
A durable run may contain several transactions, so it does not make separate acts atomic.

## Search

Declare `search.text`, optional `search.semantic`, and `search.indexes.<name>` together.
`search.text` takes own text, enum and patterned `seq` fields and links: a ref field finds the row by the
linked record's own `search.text` (an entry by its employee's number or name). It is what turns on the
toolbar search and the finder, so a page never builds a search box. A custom
index holds `dim`, `metric`, `vector`, typed `input`, `probe`, optional `rerank` and `candidates`.
The pure vector callback returns a vector or null; the engine stores and indexes it on every
commit. For I/O-derived vectors, an automation writes a vector field and the index names it.
A probe returns vector and optional where; rerank is pure ascending exact scoring on candidates.
Dimensions are at most 2000 and candidate multipliers 1–16. Call
`bolt.query({ trials: { search: { colour: input }, limit: 20 } })`; the read output and grants still apply and the
view toolbar offers every index's typed form, including custom renderers.

## Syncs

Place file and integration exchange under `syncs.<name>`. Remote syncs name `with: 'crm'`, optional
`every`/partitions, and inline `read`/`write`. A read receives cursor, partition and deliveries,
requests through its own instance, and returns rows (`$id`, `$version`, `$deleted`), cursor and
more. Only returned source fields are synced; other fields stay local. Page progress commits
atomically. A write receives op, row, changed fields and remote id/version; return the acknowledged
id/version, or null for local changes. The engine owns no-echo, ordering, idempotency, retries,
approval timing, conflict rollback and dead letters.

A file sync uses `with: 'file'`, `parser: ['xlsx', 'csv']`, optional schema/context and inline read
or write. File callback reads retain the importing/exporting caller's scope and outputs; remote
syncs read as trusted workspace. Context is input and cannot elevate authority.
Read receives parsed records with `$at` source positions and returns rows plus optional
findings/snapshot scope. Write returns export records, or `{ document: { html }, name }`. The
toolbar supplies Import, Export and Download template. Built-ins are xlsx/csv/tsv/json/ics; custom
parsers declare registered IANA `type`, extensions and an inline parse generator. Remote data
never uses a parser. File writes run the same per-verb callbacks; one refusal rolls back the file.

## Notices and documents

A model's generator `notify(event, ctx)` runs after commit, reads as workspace and returns notices.
Write events include action, records, previous and actor; approval events include move, request,
steps, requester and approvers. A notice has `title`, optional `description`, `to` recipients, optional `via`,
attachments, link and once. Recipients are team/user/policy, plus requester/approvers in approval
notices. Inbox is automatic; via names conversation connections. `ctx.notify` uses the same shape.
Document attachments convert after commit and retry with delivery.

Declare converter targets in `+workspace.ts`. Pages use `await bolt.convert({ html }, { to, name })`;
automations use `ctx.convert.document`; a file sync returns a document for Export. Page conversion
uses content already authorized to that viewer and the policy convert limit (default 30/min).

## Custom datatype renderers

Declare `customField('rating', { description, shape, validate? })` in
`data/custom_field/rating/+definition.ts`. Validation is inline and pure. The optional renderer
beside it takes `{ view }: { view: CustomFieldView<'rating'> }` from `@norbital-ai/bolt`. Show mode
provides value, dense, row and name; edit adds onChange, disabled and error. Address is supplied
when relevant. Keep native typed values through onChange.

Renderers are used implicitly in Table cells, Board cards, Form/RecordShell fields and history
diffs, Matrix labels and bulk relation pickers. With no renderer the shape supplies display and
editing. Built-in money/file/point/phone names are reserved. Renderers are statically bundled
because cells render synchronously; keep them light.
