// The strictness the type-cost work keeps (F28, compute model §5 "Cheaper types, strictness kept"): a cheaper Bolt type
// must answer the same types and refuse the same mistakes. Each `@ts-expect-error` line is a planted mistake.
import type {
	CallerQuery,
	Cursor,
	Id,
	QueryMember,
	QuerySet,
	QuerySetAnswer,
	StoredAnswer,
	StoredMember,
	Where,
	WorkspaceQuery
} from '../../src/index.ts';
import type { ReadFailed } from '../../src/decl/errors.ts';
import type { ReadableName } from '../../src/decl/names.ts';
import type { ModelWhere } from '../../src/decl/where.ts';
import type { Eff } from '../../src/decl/ctx.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(value: T): T => value;
type Answer<X> = X extends Eff<infer A, unknown> ? A : never;

declare const caller: CallerQuery<ReadFailed>;
declare const db: WorkspaceQuery;
/** A template's reader over both native reads (hr-payroll's `Read`): a member is both members at once. */
declare const both: <const M extends QuerySet>(
	set: M & {
		readonly [K in keyof M]: StoredMember<M[K]['from']> & QueryMember<M[K]['from']>;
	}
) => Eff<{ readonly [K in keyof M]: StoredAnswer<M[K]> } | QuerySetAnswer<M>>;
declare const customer: Id<'customers'>;
declare const after: Cursor;

// ── keyed reads answer each member's own rows ──
const keyed = caller.query({
	orders: {
		from: 'orders',
		where: { status: { eq: 'draft' } },
		select: { number: true, due: true, customer: { select: { name: true } } },
		all: true
	},
	buyers: {
		from: 'customers',
		where: { id: { in: { member: 'orders', field: 'customer' } } },
		limit: 5,
		after
	},
	one: { from: 'customers', id: customer, select: { tier: true } }
});
const plain = caller.query('orders', {
	where: { status: { eq: 'draft' } },
	select: { number: true, due: true, customer: { select: { name: true } } },
	all: true
});
const plainBuyers = caller.query('customers', { limit: 5 });
const plainOne = caller.query('customers', { id: customer, select: { tier: true } });
is<Eq<Answer<typeof keyed>['orders'], Answer<typeof plain>>>(true);
is<Eq<Answer<typeof keyed>['buyers'], Answer<typeof plainBuyers>>>(true);
is<Eq<Answer<typeof keyed>['one'], Answer<typeof plainOne>>>(true);
is<Eq<Answer<typeof plain>['rows'][number]['number'], string>>(true);
is<Eq<Answer<typeof plain>['rows'][number]['customer']['name'], string>>(true);

const stored = db.query({
	orders: {
		from: 'orders',
		where: { status: { eq: 'draft' } },
		select: { note: true },
		all: true
	},
	one: { from: 'customers', id: customer }
});
const storedPlain = db.query('orders', {
	where: { status: { eq: 'draft' } },
	select: { note: true },
	all: true
});
const storedOne = db.query('customers', { id: customer });
is<Eq<Answer<typeof stored>['orders'], Answer<typeof storedPlain>>>(true);
is<Eq<Answer<typeof stored>['one'], Answer<typeof storedOne>>>(true);

const joint = both({
	orders: {
		from: 'orders',
		where: { status: { eq: 'draft' } },
		select: { note: true },
		all: true
	},
	buyers: {
		from: 'customers',
		where: { id: { in: { member: 'orders', field: 'customer' } } },
		select: { name: true },
		limit: 1
	}
});
is<
	Eq<
		Answer<typeof joint>['orders']['rows'][number]['note'],
		Answer<typeof storedPlain>['rows'][number]['note']
	>
>(true);
// an optional member (a conditional spread) is read like any other
declare const maybe: boolean;
const optional = caller.query({
	orders: { from: 'orders', all: true },
	...(maybe ? {} : { named: { from: 'customers', where: { name: { eq: 'x' } }, all: true } })
});
void [keyed, stored, joint, optional];

// ── a predicate over a generic name (a template helper's `C extends ReadableName`) ──
declare const readWhere: <C extends ReadableName>(
	collection: C,
	where: ModelWhere<C> & Where<C>
) => C;
readWhere('orders', { status: { eq: 'draft' }, customer: { is: { tier: { eq: 'gold' } } } });
// @ts-expect-error W1 a field of another collection
readWhere('orders', { name: { eq: 'x' } });
// @ts-expect-error W2 an operand of the wrong kind
readWhere('orders', { due: { eq: 5 } });
// @ts-expect-error W3 a related predicate is the target's
readWhere('orders', { customer: { is: { due: { eq: 'x' } } } });
// a predicate distributes over a union of names, and there is none over no name
is<Eq<Where<'orders' | 'customers'>, Where<'orders'> | Where<'customers'>>>(true);
is<Eq<ModelWhere<'orders' | 'customers'>, ModelWhere<'orders'> | ModelWhere<'customers'>>>(true);
is<Eq<Where<never>, never>>(true);

// ── the mistakes a keyed member is refused for, through each reader ──
// ponytail: a keyed member's unknown `where` or `select` key is not refused today (no excess check through `M & …`);
// tighten in the declarations, then plant it here.
// @ts-expect-error K1 every member states its page (rule 9)
caller.query({ o: { from: 'orders' } });
// @ts-expect-error K2 an unknown collection
caller.query({ o: { from: 'nope', all: true } });
// @ts-expect-error K4 an operand of the wrong kind
caller.query({ o: { from: 'orders', where: { due: { eq: 5 } }, all: true } });
// @ts-expect-error K6 a limit and everything at once
caller.query({ o: { from: 'orders', limit: 1, all: true } });
// @ts-expect-error K7 an absent optional is absent, not `undefined` (exactOptionalPropertyTypes)
caller.query({ o: { from: 'orders', limit: 1, after: undefined } });
declare const answer: Answer<typeof keyed>;
// @ts-expect-error K9 a member's answer has only its selected fields
void answer.orders.rows[0]?.tier;
// @ts-expect-error K1 workspace
db.query({ o: { from: 'orders' } });
// @ts-expect-error K2 workspace
db.query({ o: { from: 'nope', all: true } });
// @ts-expect-error K4 workspace
db.query({ o: { from: 'orders', where: { due: { eq: 5 } }, all: true } });
// @ts-expect-error K6 workspace
db.query({ o: { from: 'orders', limit: 1, all: true } });
// @ts-expect-error K7 workspace
db.query({ o: { from: 'orders', limit: 1, after: undefined } });
// @ts-expect-error K1 joint
both({ o: { from: 'orders' } });
// @ts-expect-error K2 joint
both({ o: { from: 'nope', all: true } });
// @ts-expect-error K4 joint
both({ o: { from: 'orders', where: { due: { eq: 5 } }, all: true } });
// @ts-expect-error K6 joint
both({ o: { from: 'orders', limit: 1, all: true } });
// @ts-expect-error K7 joint
both({ o: { from: 'orders', limit: 1, after: undefined } });
