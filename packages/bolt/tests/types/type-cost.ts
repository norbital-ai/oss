// The strictness the type-cost work keeps (F28, compute model §5 "Cheaper types, strictness kept"): a cheaper Bolt type
// must answer the same types and refuse the same mistakes. Each `@ts-expect-error` line is a planted mistake.
import type {
	CallerQuery,
	Cursor,
	Id,
	PlainDate,
	ReadAnswer,
	ReadRequest,
	ReadRequestBase,
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
/** A template's reader over both native reads (hr-payroll's `Read`): one read request, either answer. */
declare const both: <const R extends ReadRequestBase>(
	request: ReadRequest<R>
) => Eff<ReadAnswer<R>>;
declare const customer: Id<'customers'>;
declare const after: Cursor;

// ── a read request answers each root's own rows; a named ref layer replaces its FK ──
const layered = caller.query({
	orders: { where: { status: { eq: 'draft' } }, fields: ['number', 'due', 'customer'] },
	'orders.customer': { fields: ['name'] },
	customers: { where: { id: { eq: customer } }, limit: 5, after }
});
type LayeredOrder = Answer<typeof layered>['orders']['rows'][number];
is<Eq<LayeredOrder['number'], string>>(true);
is<Eq<LayeredOrder['due'], PlainDate | null>>(true);
is<Eq<NonNullable<LayeredOrder['customer']>['name'], string>>(true);
is<Eq<NonNullable<LayeredOrder['customer']>['id'], Id<'customers'>>>(true);
is<Eq<Answer<typeof layered>['customers']['next'], Cursor | null>>(true);
// @ts-expect-error K0 the single-model `query(model, args)` form is gone
caller.query('orders', { all: true });

const stored = db.query({ orders: { where: { status: { eq: 'draft' } }, fields: ['note'] } });
is<Eq<Answer<typeof stored>['orders']['rows'][number]['note'], string | null>>(true);

const joint = both({ orders: { where: { status: { eq: 'draft' } }, fields: ['note'] } });
is<Eq<'note' extends keyof Answer<typeof joint>['orders']['rows'][number] ? 1 : 0, 1>>(true);
// an optional root (a conditional spread) is read like any other
declare const maybe: boolean;
const optional = caller.query({
	orders: { limit: 10 },
	...(maybe ? {} : { customers: { where: { name: { eq: 'x' } } } })
});
void [layered, stored, joint, optional];

// ── a predicate over a generic name (a template helper's `C extends ReadableName`) ──
declare const readWhere: <C extends ReadableName>(
	model: C,
	where: ModelWhere<C> & Where<C>
) => C;
readWhere('orders', { status: { eq: 'draft' }, customer: { is: { tier: { eq: 'gold' } } } });
// @ts-expect-error W1 a field of another model
readWhere('orders', { name: { eq: 'x' } });
// @ts-expect-error W2 an operand of the wrong kind
readWhere('orders', { due: { eq: 5 } });
// @ts-expect-error W3 a related predicate is the target's
readWhere('orders', { customer: { is: { due: { eq: 'x' } } } });
// a predicate distributes over a union of names, and there is none over no name
is<Eq<Where<'orders' | 'customers'>, Where<'orders'> | Where<'customers'>>>(true);
is<Eq<ModelWhere<'orders' | 'customers'>, ModelWhere<'orders'> | ModelWhere<'customers'>>>(true);
is<Eq<Where<never>, never>>(true);

// ── the mistakes a read request is refused for, through each reader ──
// @ts-expect-error K2 an unknown root
caller.query({ nope: {} });
// @ts-expect-error K4 an operand of the wrong kind
caller.query({ orders: { where: { due: { eq: 5 } } } });
// @ts-expect-error K6 `all` is gone: a list defaults to 10,000
caller.query({ orders: { all: true } });
// @ts-expect-error K7 an absent optional is absent, not `undefined` (exactOptionalPropertyTypes)
caller.query({ orders: { limit: 1, after: undefined } });
// @ts-expect-error K8 a layer the root does not declare
caller.query({ orders: {}, 'orders.owner': {} });
// @ts-expect-error K10 `after` belongs to a root
caller.query({ orders: {}, 'orders.lines': { after } });
// @ts-expect-error K11 the keyed `{ alias: { from } }` form is gone
caller.query({ o: { from: 'orders' } });
declare const answer: Answer<typeof layered>;
// @ts-expect-error K9 a root's answer has only its picked fields
void answer.orders.rows[0]?.tier;
// @ts-expect-error K2 workspace
db.query({ nope: {} });
// @ts-expect-error K4 workspace
db.query({ orders: { where: { due: { eq: 5 } } } });
// @ts-expect-error K6 workspace
db.query({ orders: { all: true } });
// @ts-expect-error K7 workspace
db.query({ orders: { limit: 1, after: undefined } });
// @ts-expect-error K8 workspace
db.query({ orders: {}, 'orders.owner': {} });
// @ts-expect-error K2 joint
both({ nope: {} });
// @ts-expect-error K4 joint
both({ orders: { where: { due: { eq: 5 } } } });
// @ts-expect-error K6 joint
both({ orders: { all: true } });
// @ts-expect-error K7 joint
both({ orders: { limit: 1, after: undefined } });
// @ts-expect-error K8 joint
both({ orders: {}, 'orders.owner': {} });
