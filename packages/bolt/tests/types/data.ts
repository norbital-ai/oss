// Type corpus for the data layer (§3.3.2–§3.3.4, §3.3.9, rules 3–5, 9, 10, P14). Each `@ts-expect-error` line is a
// planted mistake; a clean tsc proves every valid line compiles and every mistake is refused at its literal.
import { automation, customField, model } from '../../src/index.ts';
import { Decimal } from '@norbital-ai/std/decimal';
import { PlainDate as plainDate } from '@norbital-ai/std/date';
import type {
	Id,
	Insert,
	Masked,
	Patch,
	PlainDate,
	PlainTime,
	Row,
	RowApproval,
	Where
} from '../../src/index.ts';
import type { DateLiteral, Exact, ValidInput, ValueOf } from '../../src/decl/fields.ts';
import type { KindOfExpr } from '../../src/decl/model.ts';
import type { Columns, ColumnValue, StoredRow } from '../../src/decl/names.ts';
import * as m from './fixture/models.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// Non-primitive values on unknown keys still become never, regardless of their shape.
is<
	Eq<Exact<{ keep: 1; extra: { nested: true } }, { keep: number }>, { keep: number; extra: never }>
>();
is<Eq<Exact<{ extra: readonly [{ a: 1 }] | (() => void) }, {}>, { extra: never }>>();
is<Eq<Exact<{ extra: unknown }, {}>, { extra: never }>>();
is<Eq<Exact<{ extra: never }, {}>, { extra: never }>>();

// Array validation precedes function terminals, including values satisfying both types.
declare const callableJsonObjects: (() => void) & readonly { a: boolean }[];
declare const callableJsonBools: (() => void) & readonly boolean[];
model('data_case', {
	description: 'X',
	label: 'j',
	fields: {
		// @ts-expect-error callable object arrays retain recursive JSON default validation
		j: { kind: 'json', shape: { kind: 'list', of: { kind: 'bool' } }, default: callableJsonObjects }
	}
});
model('data_case', {
	description: 'X',
	label: 'j',
	fields: {
		j: { kind: 'json', shape: { kind: 'list', of: { kind: 'bool' } }, default: callableJsonBools }
	}
});

// ── rows, inputs and values inferred from the literals ──
is<Eq<Columns<never>, never>>();
is<Eq<ColumnValue<'customers' | 'orders', 'id'>, Id<'customers'> | Id<'orders'>>>();
is<Eq<ColumnValue<'orders' | 'notice_notes', 'note'>, string | null>>();
is<Eq<Row<'orders'>['status'], 'draft' | 'submitted' | 'ordered'>>();
is<Eq<Row<'orders'>['number'], string>>(); // seq with a pattern
is<Eq<Row<'orders'>['total'], Decimal>>(); // sum roll-up
is<Eq<Row<'orders'>['due_soon'], PlainDate | null | Masked>>(); // optional date propagates through computed SQL; masked: sales_rep's root layer omits it
is<Eq<ColumnValue<'customers', 'name_upper'>, string>>();
is<Eq<ColumnValue<'customers', 'email_lower'>, string | null>>();
is<Eq<ColumnValue<'customers', 'email_label'>, string>>();
is<Eq<ColumnValue<'customers', 'email_default'>, string>>();
is<Eq<ColumnValue<'customers', 'email_chain'>, string | null>>();
is<Eq<Row<'orders'>['customer'], Id<'customers'>>>(); // inline ref field
is<Eq<Row<'orders'>['owner'], Id<'sys_user'> | null>>();
is<Eq<Row<'customers'>['tier'], 'basic' | 'gold'>>();
is<Eq<Row<'customers'>['tags'], readonly string[] | null | Masked>>(); // masked: sales_rep reads name and tier
is<Eq<Row<'sites'>['open'], { readonly from: PlainDate; readonly to: PlainDate | null }>>();
is<Eq<Row<'sites'>['location'], { readonly lat: number; readonly lng: number } | null | Masked>>();
is<
	Eq<
		keyof Row<'sites'>,
		| 'name'
		| 'location'
		| 'customer'
		| 'open'
		| 'rating'
		| 'checklist'
		| 'id'
		| 'revision'
		| 'created_at'
		| 'updated_at'
		| 'created_by'
		| 'updated_by'
		| '$sync'
		| '$approval'
	>
>();
is<
	Eq<StoredRow<'sites'>['rating'], { readonly score: number; readonly note?: string | null } | null>
>(); // custom field
is<
	Eq<StoredRow<'sites'>['checklist'], readonly { readonly item: string; readonly done: boolean }[]>
>();
is<Eq<'total' extends keyof StoredRow<'orders'> ? 1 : 0, 0>>(); // transforms never see derived values (rule 10)
// an input takes a row's value or the plain literal decode accepts (ISO text, decimal text or an integer)
type Dec = Decimal | number | `${number}`;
// a create tree: the root's declared columns and, per declared write layer, an array of that layer's rows
type Flat<T> = { [K in keyof T]: T[K] };
is<Eq<keyof Insert<'orders'>, 'customer' | 'note' | 'due' | 'lines'>>();
is<Eq<Insert<'orders'>['customer'], Id<'customers'>>>();
is<Eq<Insert<'orders'>['due'], PlainDate | DateLiteral | null | undefined>>();
is<
	Eq<
		Flat<NonNullable<Insert<'orders'>['lines']>[number]>,
		{ readonly item: string; readonly qty: Dec; readonly price: Dec }
	>
>();
is<Eq<keyof Patch<'orders'>, 'status' | 'note' | 'due' | 'placed_at' | 'lines'>>();
is<
	Eq<
		KindOfExpr<
			{ when: [{ gt: [{ field: 'a' }, 1] }, { field: 'a' }, 0.5] },
			{ a: { kind: 'int' } }
		>,
		'decimal'
	>
>();

// Defaults still depend on multiplicity and enum values; a broad kind union must not acquire a scalar default.
is<Eq<ValidInput<{ kind: 'text'; max: 20 }>['default'], string | undefined>>();
is<Eq<ValidInput<{ kind: 'text'; many: true }>['default'], readonly string[] | undefined>>();
is<
	Eq<ValidInput<{ kind: 'enum'; values: readonly ['a', 'b'] }>['default'], 'a' | 'b' | undefined>
>();
is<Eq<ValidInput<{ kind: 'text' | 'int' }>['default'], undefined>>();
is<Eq<ValidInput<{ kind: 'decimal'; scale: 2 }>['default'], Dec | undefined>>();
// An impossible discriminant must retain the nested-shape branch instead of entering the scalar shortcut.
is<Eq<ValidInput<{ kind: never; fields: {} }>, ValidInput<{ kind: 'object'; fields: {} }>>>();
// ID values keep their target brand and the original impossible-kind fallback.
is<Eq<ValueOf<{ kind: 'id'; of: 'customers'; optional: true }>, Id<'customers'> | null>>();
is<Eq<ValueOf<{ kind: never; of: 'customers' }>, string>>();

// ── predicates (K3) ──
const w1: Where<'orders'> = {
	status: { in: ['draft', 'submitted'] },
	due: { lte: plainDate('2026-11-24') },
	customer: { is: { tier: { eq: 'gold' }, name: { like: 'A%' } } },
	lines: { some: { qty: { gt: 10 } } },
	or: [{ owner: { eq: { var: 'requestor.id' } } }, { note: { isNull: true } }]
};
const w2: Where<'customers'> = { email: { eq: { var: 'requestor.email' } } };
void w1;
void w2;
// @ts-expect-error W1 a state value that does not exist
const e1: Where<'orders'> = { status: { eq: 'shipped' } };
// @ts-expect-error W2 an unknown operator
const e2: Where<'orders'> = { note: { startsWith: 'x' } };
// @ts-expect-error W3 `is` and id operators are exclusive arms... and `like` is text only
const e3: Where<'orders'> = { due: { like: '2026%' } };
// @ts-expect-error W4 a field the model does not expose (sites reads only four fields)
const e4: Where<'sites'> = { zone: { eq: 'Asia/Singapore' } };
// @ts-expect-error W5 a `where` crosses only the layers its model's read declares (customers declares no orders layer)
const e5: Where<'customers'> = { orders: { none: {} }, sites: { count: { gte: 2 } } };
// @ts-expect-error W5 nor a one-relation it does not declare (sites declares no customer layer)
const e5b: Where<'sites'> = { customer: { is: { tier: { eq: 'gold' } } } };
// @ts-expect-error W6 clock operands are not values in a read predicate
const e6: Where<'orders'> = { due: { lt: { now: '-1h' } } };
// @ts-expect-error W7 `{ var: 'requestor.id' }` on an FK that is not a member
const e7: Where<'orders'> = { customer: { eq: { var: 'requestor.id' } } };
// @ts-expect-error W8 a many-relation takes quantifiers, not id operators
const e8: Where<'orders'> = { lines: { isNull: true } };
void e1;
void e2;
void e3;
void e4;
void e5;
void e5b;
void e6;
void e7;
void e8;

// ── model() ──
// @ts-expect-error M1 unknown kind
model('data_case', { description: 'x', label: 'a', fields: { a: { kind: 'txt' } } });
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M2 unknown text format
	fields: { a: { kind: 'text', format: 'handle' } }
});
// @ts-expect-error M3 vector without a metric
model('data_case', { description: 'x', label: 'a', fields: { a: { kind: 'vector', dim: 3 } } });
model('data_case', {
	description: 'x',
	label: 's',
	// @ts-expect-error M4 state edge names a state that does not exist
	fields: { s: { kind: 'state', initial: 'a', states: { a: { to: ['zz'] } } } }
});
model('data_case', {
	description: 'x',
	label: 's',
	// @ts-expect-error M5 initial is not a state
	fields: { s: { kind: 'state', initial: 'q', states: { a: {} } } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M6 a misspelt modifier (options are exact, rule 5)
	fields: { a: { kind: 'text', optinal: true } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M7 a derived kind takes no `optional`
	fields: { a: { kind: 'count', of: 'lines', optional: true } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M8 enum default outside its values
	fields: { a: { kind: 'enum', values: ['x', 'y'], default: 'z' } }
});
// @ts-expect-error M9 an input-only kind on a model
model('data_case', { description: 'x', label: 'a', fields: { a: { kind: 'number' } } });
// @ts-expect-error M10 a system column name
model('data_case', { description: 'x', label: 'a', fields: { id: { kind: 'text' } } });
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'date' } },
	// @ts-expect-error M11 computed kind differs from the tree's result kind
	computed: { b: { kind: 'text', expr: { plusDays: [{ field: 'a' }, 1] } } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'text' } },
	// @ts-expect-error M12 plusDays on a non-date
	computed: { b: { kind: 'date', expr: { plusDays: [{ field: 'a' }, 1] } } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'date' } },
	// @ts-expect-error M13 round on a date
	computed: { b: { kind: 'date', expr: { round: [{ field: 'a' }, 2] } } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'int' } },
	// @ts-expect-error M14 an unknown field in a computed tree
	computed: { b: { kind: 'int', expr: { plus: [{ field: 'nope' }, 1] } } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'money' } },
	// @ts-expect-error M15 money times money
	computed: { b: { kind: 'money', expr: { times: [{ field: 'a' }, { field: 'a' }] } } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'int' } },
	// @ts-expect-error M16 search over a non-text field
	search: { text: ['a'] }
});
// a patterned seq is text in storage and in the search document
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'seq', pattern: 'P-{yyyy}-{0000}' }, b: { kind: 'text' } },
	search: { text: ['a', 'b'] }
});
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'seq' } },
	// @ts-expect-error M16b a seq without a pattern is a number
	search: { text: ['a'] }
});
// @ts-expect-error M17 a json field in a key (not btree)
model('data_case', { description: 'x', label: 'a', fields: { a: { kind: 'json' } }, key: ['a'] });
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'date' } },
	// @ts-expect-error M18 noOverlap over a field that is not a period
	noOverlap: [{ key: [], period: 'a' }]
});
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'int' }, d: { kind: 'date' } },
	// @ts-expect-error M19 a check comparing an int to a date field
	check: { c: { a: { lte: { field: 'd' } } } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M20 money currency naming a field that is not a currency
	fields: { a: { kind: 'money', currency: 'b' }, b: { kind: 'text' } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	fields: { a: { kind: 'text' } },
	// @ts-expect-error M21 an unknown top-level option
	temporal: true
});
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M22 a json shape with an unknown member kind
	fields: { a: { kind: 'json', shape: { kind: 'object', fields: { b: { kind: 'strin' } } } } }
});
// a time field's precision: the unit its picker offers and snaps to; a date or a date period has no hour
model('data_case', {
	description: 'x',
	label: 'm',
	fields: {
		m: { kind: 'date', precision: 'month' },
		w: { kind: 'period', of: 'date', precision: 'week' },
		h: { kind: 'instant', precision: 'hour' },
		y: { kind: 'period', of: 'instant', precision: 'year' },
		t: { kind: 'time', precision: 'hour' }
	}
});
is<Eq<ValueOf<{ kind: 'date'; precision: 'month' }>, PlainDate>>(); // precision never changes a value's type
is<Eq<ValueOf<{ kind: 'time'; precision: 'hour' }>, PlainTime>>();
is<PlainTime extends string ? true : false>();
is<string extends PlainTime ? false : true>();
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M23 a date has no hour precision
	fields: { a: { kind: 'date', precision: 'hour' } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M24 a time has no month precision
	fields: { a: { kind: 'time', precision: 'month' } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M25 a date period has no minute precision
	fields: { a: { kind: 'period', of: 'date', precision: 'minute' } }
});
model('data_case', {
	description: 'x',
	label: 'a',
	// @ts-expect-error M26 precision on a kind that is not a time
	fields: { a: { kind: 'int', precision: 'day' } }
});

// ── refs live on the model's fields ──
model('orders', {
	...m.orders.spec,
	// @ts-expect-error R2 unknown ref target
	fields: { ...m.orders.spec.fields, customer: { kind: 'ref', to: 'custmers' } }
});
model('orders', {
	...m.orders.spec,
	fields: {
		...m.orders.spec.fields,
		// @ts-expect-error R3 setNull on a required ref
		customer: { kind: 'ref', to: 'customers', onDelete: 'setNull' }
	}
});
model('orders', {
	...m.orders.spec,
	// @ts-expect-error R4 an inverse named after a grant key
	fields: { ...m.orders.spec.fields, customer: { kind: 'ref', to: 'customers', inverse: 'read' } }
});
model('orders', {
	...m.orders.spec,
	// @ts-expect-error R5 an inverse colliding with a field of the target
	fields: { ...m.orders.spec.fields, customer: { kind: 'ref', to: 'customers', inverse: 'name' } }
});
// R6 (two inverses of one name on one target) fails the generated `__verify` line.
model('orders', {
	...m.orders.spec,
	fields: {
		...m.orders.spec.fields,
		// @ts-expect-error R8 a target predicate naming an unknown field
		customer: { kind: 'ref', to: 'customers', where: { nope: { eq: 1 } } }
	}
});
model('order_lines', {
	...m.order_lines.spec,
	fields: {
		...m.order_lines.spec.fields,
		// @ts-expect-error R9 an owned child restricting its parent's delete
		order: { kind: 'ref', to: 'orders', owned: true, onDelete: 'restrict' }
	}
});
model('orders', {
	...m.orders.spec,
	fields: {
		...m.orders.spec.fields,
		// @ts-expect-error R10 an actor id default on a ref that is not a member
		customer: { kind: 'ref', to: 'customers', default: { var: 'requestor.id' } }
	}
});

// ── custom fields validate inside their declaration, from generated shape data ──
customField('rating', {
	description: 'x',
	// @ts-expect-error F1 a shape with an unknown kind
	shape: { kind: 'object', fields: { a: { kind: 'txt' } } }
});
customField('variant', {
	description: 'A tagged value',
	shape: {
		kind: 'union',
		by: 'type',
		arms: { a: { n: { kind: 'int' } }, b: { s: { kind: 'text' } } }
	},
	validate: (v) =>
		v.type === 'a' ? (v.n > 0 ? undefined : 'positive') : v.s.length > 0 ? undefined : 'empty'
});
customField('variant', {
	description: 'A tagged value',
	shape: {
		kind: 'union',
		by: 'type',
		arms: { a: { n: { kind: 'int' } }, b: { s: { kind: 'text' } } }
	},
	// @ts-expect-error F2 the generated union must be narrowed before reading an arm
	validate: (v) => (v.n > 0 ? undefined : 'x')
});

// ── exposure is part of the model ──
// A model mirrored by a sync still validates edits to its local fields.
model('products', {
	...m.products.spec,
	update: {
		...m.products.spec.update,
		transform: function* (changes) {
			return changes.map(({ set }) => set);
		}
	}
});
// @ts-expect-error C6 a misspelt create column
model('orders', { ...m.orders.spec, create: { columns: { orders: ['nte'] } } });
// @ts-expect-error C7 a derived field in an allowlist
model('orders', { ...m.orders.spec, update: { columns: { orders: ['total'] } } });
// @ts-expect-error C8 a flat column list: write columns are a layer map
model('orders', { ...m.orders.spec, update: { columns: ['note'] } });
// @ts-expect-error C9 `with` relation-action allowlists are gone: a write layer is a `columns` path
model('orders', { ...m.orders.spec, update: { columns: { orders: [] }, with: { lines: {} } } });
// @ts-expect-error C10 an unexposable read field
model('orders', { ...m.orders.spec, read: { orders: { fields: ['nope'] } } });
// @ts-expect-error C10b a read without its path key (`relations` is gone)
model('orders', { ...m.orders.spec, read: { fields: ['note'], relations: ['lines'] } });
// @ts-expect-error C11 declared queries are gone: read the layers, transform in a src/lib helper
model('orders', { ...m.orders.spec, queries: {} });
model('orders', {
	...m.orders.spec,
	search: {
		...m.orders.spec.search,
		// @ts-expect-error C14 search candidates cannot exceed 16
		indexes: { by_colour: { ...m.orders.spec.search.indexes.by_colour, candidates: 32 } }
	}
});
model('orders', {
	...m.orders.spec,
	// @ts-expect-error C15 a notification team must be a source handle
	notify: function* () {
		return [{ title: 't', to: [{ team: 42 }] }];
	}
});
model('orders', {
	...m.orders.spec,
	// @ts-expect-error C16 a field name is not a user's branded id
	notify: function* () {
		return [{ title: 't', to: [{ user: 'customer' }] }];
	}
});
// @ts-expect-error C18 an unknown model option
model('orders', { ...m.orders.spec, hooks: {} });

// ── each callback lives on what triggers it ──
model('orders', {
	...m.orders.spec,
	update: {
		...m.orders.spec.update,
		transform: function* (changes, { now }) {
			return changes.map(({ before, set }) =>
				set.status === 'submitted' && before.status !== 'submitted'
					? { ...set, placed_at: now }
					: set
			);
		}
	},
	delete: {
		check: function* (rows, ctx) {
			if (rows.some((row) => row.status === 'ordered'))
				return yield* ctx.refuse('An ordered order stays.');
		}
	},
	search: {
		...m.orders.spec.search,
		indexes: {
			by_colour: {
				...m.orders.spec.search.indexes.by_colour,
				probe: ({ lab }) => ({ vector: lab, where: { status: { eq: 'ordered' } } })
			}
		}
	}
});
automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* ({ target }, ctx) {
		yield* ctx.act('orders.update', [
			{
				target: target,
				set: { status: 'submitted' }
			}
		]);
		// a named ref layer (orders.customer) replaces its FK with the row or null
		const open = yield* ctx.query({
			orders: { where: { status: { ne: 'ordered' } }, fields: ['total', 'customer'] },
			'orders.customer': { fields: ['name'] }
		});
		const first = open.orders.rows[0];
		if (first !== undefined && first.customer !== null) {
			const n: string = first.customer.name;
			void n;
			// Caller metadata belongs to the root row, never its layer rows.
			is<Eq<typeof first.$approval, RowApproval | undefined>>();
			is<Eq<typeof first.$sync, Row<'orders'>['$sync']>>();
			is<Eq<'$approval' extends keyof typeof first.customer ? 1 : 0, 0>>();
		}
		// @ts-expect-error B9 the single-model `query(model, args)` form is gone: every read is a read request
		yield* ctx.query('orders', { all: true });
	}
});
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* ({ ids, note }, ctx) {
		yield* ctx.act(
			'orders.update',
			ids.map((id) => ({ target: id, set: { note } }))
		);
		const id = ids[0];
		const order =
			id === undefined
				? undefined
				: (yield* ctx.query({
						orders: { where: { id: { eq: id } }, fields: ['customer'], limit: 1 }
					})).orders.rows[0];
		if (order !== undefined)
			yield* ctx.act('orders.create', [
				{
					customer: order.customer,
					lines: [{ item: 'x', qty: Decimal.of(1), price: Decimal.of(2) }]
				}
			]);
		const { customers } = yield* ctx.query({ customers: { where: { tier: { eq: 'gold' } } } });
		return customers.rows.length;
	}
});
automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* ({ target }, ctx) {
		// @ts-expect-error B4 act on an unknown callable
		yield* ctx.act('orders.shred', { target: target });
	}
});
automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* ({ target }, ctx) {
		const order =
			(yield* ctx.query({ orders: { where: { id: { eq: target } }, limit: 1 } })).orders.rows[0] ??
			null;
		if (order === null) return;
		yield* ctx.act('orders.update', [
			{
				target: target,
				// @ts-expect-error B5 a field outside the update allowlist
				set: { customer: order.customer }
			}
		]);
	}
});
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		// @ts-expect-error B6 a create missing a required field
		yield* ctx.act('orders.create', [{ note: 'x' }]);
		return 1;
	}
});
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* ({ ids }, ctx) {
		const id = ids[0];
		if (id !== undefined) {
			// @ts-expect-error B7 an upsert requires an explicit conflict policy
			yield* ctx.act('orders.upsert', [{ id, note: 'x' }]);
		}
		return 1;
	}
});
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		// @ts-expect-error B8 an automation has no implicit record target
		return ctx.target.id.length;
	}
});
model('orders', {
	...m.orders.spec,
	search: {
		...m.orders.spec.search,
		// @ts-expect-error B10 an index pointing to a field that is not a vector
		indexes: { by_colour: { ...m.orders.spec.search.indexes.by_colour, vector: 'note' } }
	}
});
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		// @ts-expect-error B11 a model without a create exposure has no create callable
		yield* ctx.act('notices.create', [{}]);
		return 1;
	}
});

// Native sequence labels may be selected explicitly for retained business documents.
model('orders', {
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (inputs, ctx) {
			const labels = yield* ctx.db.query({ orders: { fields: ['number'] } });
			const number: string = labels.orders.rows[0]!.number;
			void number;
			// a workspace read request reads the root layer's declared fields, unmasked: the sequence label, roll-ups and
			// computed fields included (`read: 'all'` declares them)
			const ordinary = yield* ctx.db.query({ orders: {} });
			const label: string = ordinary.orders.rows[0]!.number;
			const total: Decimal = ordinary.orders.rows[0]!.total;
			const soon: PlainDate | null = ordinary.orders.rows[0]!.due_soon;
			void [label, total, soon];
			// @ts-expect-error a field the root layer does not declare
			yield* ctx.db.query({ orders: { fields: ['nope'] } });
			return inputs;
		}
	}
});
