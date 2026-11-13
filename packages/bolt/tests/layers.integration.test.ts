// P2/P3 gates end to end on PGlite (decisions 3, 6, 8): authority is per access point. A root's policy alone filters
// its read layers, and the output it reads fixes their fields; a layer model's own grants are never consulted; a model without `read` is a layer, never
// a root; a user `where` only narrows. Writes are batches: `columns` are admitted before any guest code, then ONE
// `check` per verb judges the whole batch tree; `deny` refuses it, `approve` holds it.
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Schema, type Scope } from 'effect';
import { input_schema } from '@norbital-ai/store/kind';
import type { Authority } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { dynamic_read } from '../src/protocol/read-request.ts';
import {
	NativeReadRow,
	TestWorkspace,
	type Kit,
	type WorkspaceServices
} from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { act_reply, q_reply, route_fixture, type FixtureRoute } from './support/route-fixture.ts';

const ACME = '0199a000-0000-4000-8000-0000000000a1';
const N1 = '0199a000-0000-4000-8000-0000000000b1',
	N2 = '0199a000-0000-4000-8000-0000000000b2',
	S1 = '0199a000-0000-4000-8000-0000000000b3';
const L0 = '0199a000-0000-4000-8000-0000000000c1',
	L5 = '0199a000-0000-4000-8000-0000000000c2',
	M0 = '0199a000-0000-4000-8000-0000000000c3',
	T5 = '0199a000-0000-4000-8000-0000000000c4';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		// no `read`: stored, and a layer of orders, never a root
		parties: {
			description: 'A party',
			record_label: 'record.name',
			fields: {
				name: { kind: 'text' },
				code: { kind: 'text' },
				credit_limit: { kind: 'decimal', scale: 2 }
			}
		},
		orders: {
			description: 'An order',
			record_label: 'record.number',
			fields: {
				number: { kind: 'text' },
				region: { kind: 'enum', values: ['north', 'south'] },
				status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' }
			}
		},
		order_lines: {
			description: 'A line',
			record_label: 'record.product',
			fields: {
				product: { kind: 'text' },
				quantity: { kind: 'int' },
				cost: { kind: 'decimal', scale: 2, optional: true }
			}
		}
	},
	relationships: {
		'orders.party': { to: 'parties', inverse: 'orders', optional: true },
		'order_lines.order': { to: 'orders', inverse: 'lines', owned: true }
	},
	exposures: {
		orders: {
			outputs: {
				default: {
					orders: { fields: 'all' },
					'orders.party': { fields: ['name', 'code', 'credit_limit'] },
					'orders.lines': { fields: 'all' }
				},
				brief: {
					orders: { fields: ['number', 'region', 'party'] },
					'orders.party': { fields: ['name', 'code'] }
				}
			},
			create: {
				columns: {
					orders: ['number', 'region', 'status', 'party'],
					'orders.lines': ['product', 'quantity', 'cost']
				}
			},
			update: { columns: { orders: ['status'], 'orders.lines': ['quantity'] } },
			delete: {}
		},
		// a root of its own that `rep` holds no grant on
		order_lines: { outputs: { default: { order_lines: { fields: 'all' } } } }
	},
	integrations: {},
	policies: {
		rep: {
			description: 'Northern sales, through the order tree',
			grants: {
				orders: {
					outputs: {
						default: {
							scopes: { orders: { region: { eq: 'north' } }, 'orders.lines': { cost: { gt: 0 } } }
						}
					},
					create: {
						columns: {
							orders: ['number', 'region', 'status', 'party'],
							'orders.lines': ['product', 'quantity']
						},
						verdict: true
					},
					update: { verdict: true },
					delete: { verdict: true }
				}
			}
		},
		reviewer: { description: 'Finance', grants: { orders: { outputs: { default: {} } } } },
		partner: {
			description: 'Northern orders, briefly',
			grants: {
				orders: { outputs: { brief: { scopes: { orders: { region: { eq: 'north' } } } } } }
			}
		}
	},
	teams: { finance: { policies: ['reviewer'] }, sales: { policies: ['rep'] } },
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
/** `rep`'s checks: `COUNT` answers the batch it judged (rows, nested lines), a non-positive quantity is denied at its
 * row, a `BIG` order is approved by finance; an update needs a draft with lines; a delete is always denied. */
const source = `export default { policy: { rep: { grants: { orders: {
	create: { verdict: function* (changes, ctx) {
		const rows = changes.map((change) => change.after);
		const lines = rows.flatMap((r) => r.lines ?? []);
		if (rows.some((r) => r.number === 'COUNT')) return yield* ctx.refuse('rows:' + rows.length + ';lines:' + lines.length);
		const row = rows.findIndex((r) => (r.lines ?? []).some((l) => typeof l !== 'string' && l.quantity <= 0));
		if (row >= 0) return yield* ctx.refuse('Quantities must be positive.', { row, field: 'region' });
		if (rows.some((r) => r.number.startsWith('BIG'))) return ctx.approve({ steps: [{ name: 'Finance', teams: ['finance'] }] });
		return ctx.allow();
	} },
	update: { verdict: function* (changes, ctx) {
		const row = changes.findIndex((c) => c.before.status !== 'draft' || c.before.lines.length === 0);
		return row >= 0 ? yield* ctx.refuse('Only a draft with lines changes.', { row }) : ctx.allow();
	} },
	delete: { verdict: function* (rows, ctx) { return yield* ctx.refuse('Reps never delete.'); } }
} } } } };`;
const seed = {
	parties: [{ id: ACME, name: 'Acme', code: 'AC', credit_limit: '1000.00' }],
	orders: [
		{ id: N1, number: 'N1', region: 'north', status: 'draft', party: ACME },
		{ id: N2, number: 'N2', region: 'north', status: 'draft', party: ACME },
		{ id: S1, number: 'S1', region: 'south', status: 'draft', party: ACME }
	],
	order_lines: [
		{ id: L0, order: N1, product: 'free', quantity: 1, cost: '0.00' },
		{ id: L5, order: N1, product: 'paid', quantity: 2, cost: '5.00' },
		{ id: M0, order: N2, product: 'free', quantity: 1, cost: '0.00' },
		{ id: T5, order: S1, product: 'paid', quantity: 3, cost: '5.00' }
	]
};
const workspace = Layer.unwrap(
	program(source).pipe(Effect.map((guest) => TestWorkspace.layer({ manifest, guest, seed })))
);
const setup = Effect.gen(function* () {
	const t = yield* TestWorkspace;
	const route = yield* route_fixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
	return { t, route, rep: yield* t.as(t.member(['rep'], { teams: ['sales'] })) };
});
const act = (route: FixtureRoute, t: Kit, who: Authority, callable: string, input: Json) =>
	act_reply(route, who, { acts: { [callable]: input }, issued_at: t.clock.now() }).pipe(
		Effect.map((reply) => reply.outcome)
	);
/** A raw `/q` read: what a page or another host could put on the wire, typed or not. */
const raw = (route: FixtureRoute, who: Authority, request: Json) =>
	q_reply(route, who, { reads: [{ m: 'query', a: [request] }] });
const ids = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id);
const orders_page = <A>(row: Schema.Decoder<A>) =>
	Schema.Struct({ orders: Schema.Struct({ rows: Schema.Array(row) }) });
const OrderIds = orders_page(NativeReadRow);
const NativeDecimal = Schema.toType(input_schema({ kind: 'decimal', scale: 2 }));
const Party = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		code: Schema.String,
		credit_limit: NativeDecimal
	}),
	NativeReadRow.records
);
const BriefParty = Schema.StructWithRest(
	Schema.Struct({ id: Schema.String, name: Schema.String, code: Schema.String }),
	NativeReadRow.records
);
const CreditParty = Schema.StructWithRest(
	Schema.Struct({ id: Schema.String, name: Schema.String, credit_limit: NativeDecimal }),
	NativeReadRow.records
);
const OrdersWithParty = orders_page(
	Schema.StructWithRest(
		Schema.Struct({ ...NativeReadRow.schema.fields, number: Schema.String, party: Schema.NullOr(Party) }),
		NativeReadRow.records
	)
);
const OrdersWithBriefParty = orders_page(
	Schema.StructWithRest(
		Schema.Struct({ ...NativeReadRow.schema.fields, party: Schema.NullOr(BriefParty) }),
		NativeReadRow.records
	)
);
const OrdersWithCreditParty = orders_page(
	Schema.StructWithRest(
		Schema.Struct({ ...NativeReadRow.schema.fields, party: Schema.NullOr(CreditParty) }),
		NativeReadRow.records
	)
);
const OrdersWithLines = orders_page(
	Schema.StructWithRest(
		Schema.Struct({
			...NativeReadRow.schema.fields,
			lines: Schema.Array(
				Schema.StructWithRest(
					Schema.Struct({
						id: Schema.String,
						product: Schema.String,
						quantity: Schema.Int,
						cost: Schema.NullOr(NativeDecimal)
					}),
					NativeReadRow.records
				)
			)
		}),
		NativeReadRow.records
	)
);
// Reads never write, so one workspace serves every read; the writes share a second one.
const run = <A, E, R>(body: Effect.Effect<A, E, R | Scope.Scope>) => Effect.scoped(body);

layer(workspace)('read layers: one access point, the root policy alone', (it) => {
	it.effect('the root `where` filters roots; a user `where` narrows it and never widens it', () =>
		run(
			Effect.gen(function* () {
				const { rep } = yield* setup;
				const all = dynamic_read({ orders: { order_by: 'number' } });
				const allPage = yield* rep.query(all).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrderIds)));
				expect(ids(allPage.orders.rows)).toEqual([N1, N2]);
				const south = dynamic_read({ orders: { where: { region: { eq: 'south' } } } });
				const southPage = yield* rep.query(south).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrderIds)));
				expect(southPage.orders.rows).toEqual([]);
				const either = dynamic_read({
					orders: {
						where: { or: [{ region: { eq: 'south' } }, { region: { eq: 'north' } }] },
						order_by: 'number'
					}
				});
				const eitherPage = yield* rep.query(either).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrderIds)));
				expect(ids(eitherPage.orders.rows)).toEqual([N1, N2]);
			})
		)
	);

	it.effect(
		'a layer row shows with no grant on its model; reading that model as a root is its own access point',
		() =>
			run(
				Effect.gen(function* () {
					const { rep } = yield* setup;
					const tree = dynamic_read({ orders: { where: { number: { eq: 'N1' } }, lines: {} } });
					const treePage = yield* rep.query(tree).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrdersWithLines)));
					const [order] = treePage.orders.rows;
					expect(order).toMatchObject({ id: N1, lines: [{ id: L5, product: 'paid' }] });
					const lines = dynamic_read({ order_lines: {} });
					expect(yield* Effect.flip(rep.query(lines))).toMatchObject({ code: 'forbidden' });
				})
			)
	);

	it.effect('a model without `read` is a layer, refused as a root', () =>
		run(
			Effect.gen(function* () {
				const { rep } = yield* setup;
				const layer = dynamic_read({ orders: { where: { number: { eq: 'N1' } }, fields: ['number', 'party'], party: {} } });
				const layerPage = yield* rep.query(layer).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrdersWithParty)));
				expect(layerPage.orders.rows).toMatchObject([
					{ id: N1, number: 'N1', party: { id: ACME, name: 'Acme', code: 'AC' } }
				]);
				const root = dynamic_read({ parties: {} });
				const refused = yield* Effect.flip(rep.query(root));
				expect(refused.message).toContain('no read root');
			})
		)
	);

	it.effect(
		'a layer `where` filters only that layer: a list shrinks, a ref nulls, the root stays',
		() =>
			run(
				Effect.gen(function* () {
					const { rep } = yield* setup;
					// the policy's `orders.lines` where (cost > 0) drops free lines, never the order that holds them
					const lines = dynamic_read({ orders: { order_by: 'number', lines: {} } });
					const linesPage = yield* rep.query(lines).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrdersWithLines)));
					expect(linesPage.orders.rows.map((o) => [o.id, ids(o.lines)])).toEqual([
						[N1, [L5]],
						[N2, []]
					]);
					// a user layer where narrows the policy's further, still per layer
					const narrower = dynamic_read({ orders: { order_by: 'number', lines: { where: { quantity: { gt: 2 } } } } });
					const narrowerPage = yield* rep.query(narrower).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrdersWithLines)));
					expect(narrowerPage.orders.rows.map((o) => [o.id, ids(o.lines)])).toEqual([
						[N1, []],
						[N2, []]
					]);
					const ref = dynamic_read({ orders: { order_by: 'number', fields: ['number', 'party'], party: { where: { code: { eq: 'ZZ' } } } } });
					const refPage = yield* rep.query(ref).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrdersWithParty)));
					expect(refPage.orders.rows).toMatchObject([
						{ id: N1, party: null },
						{ id: N2, party: null }
					]);
				})
			)
	);

	it.effect(
		'an output fixes its layer fields: a field it omits is refused even when named; its rows are its grant`s',
		() =>
			run(
				Effect.gen(function* () {
					const { t } = yield* setup;
					const partner = yield* t.as(t.member(['partner']));
					const brief = dynamic_read({ orders: { output: 'brief', where: { number: { eq: 'N1' } }, fields: ['party'], party: {} } });
					const briefPage = yield* partner.query(brief).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrdersWithBriefParty)));
					const [row] = briefPage.orders.rows;
					expect(row?.party).toEqual(expect.objectContaining({ name: 'Acme', code: 'AC' }));
					expect(row?.party).not.toHaveProperty('credit_limit');
					const named = dynamic_read({ orders: { output: 'brief', fields: ['party'], party: { fields: ['name', 'credit_limit'] } } });
					expect(yield* Effect.flip(partner.query(named))).toMatchObject({ code: 'invalid' });
					// the partner holds no `default` grant: reading it is forbidden
					expect(yield* Effect.flip(partner.query(dynamic_read({ orders: {} })))).toMatchObject({
						code: 'forbidden'
					});
					// the brief rows are the partner's grant's: the northern orders only
					const all = dynamic_read({ orders: { output: 'brief', order_by: 'number' } });
					const allPage = yield* partner.query(all).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrderIds)));
					expect(ids(allPage.orders.rows)).toEqual([N1, N2]);
					// a caller reading `default` reads the credit limit
					const creditPage = yield* (yield* t.as(t.member(['reviewer']))).query(
							dynamic_read({ orders: { where: { number: { eq: 'N1' } }, fields: ['party'], party: { fields: ['name', 'credit_limit'] } } })
						).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrdersWithCreditParty)));
					expect(creditPage.orders.rows[0]?.party).toHaveProperty('credit_limit');
				})
			)
	);

	it.effect(
		'the wire refuses an unknown option, a path outside the declaration and a sixth level',
		() =>
			run(
				Effect.gen(function* () {
					const { route, rep } = yield* setup;
					for (const request of [
						{ orders: { nope: 1 } },
						{ orders: { customer: {} } },
						{ orders: { lines: { order: { lines: { order: { lines: {} } } } } } },
						{ orders: { lines: { as_of: '2026-01-01T00:00:00Z' } } },
						{ 'orders.lines': {} }
					])
						expect(yield* Effect.flip(raw(route, rep.authority, request))).toMatchObject({
							_tag: 'ReadFailed'
						});
				})
			)
	);
});

layer(workspace)('write layers: columns first, then one check over the batch', (it) => {
	it.effect('a column outside the grant`s columns is refused before `check` runs', () =>
		run(
			Effect.gen(function* () {
				const { t, route, rep } = yield* setup;
				// `COUNT` would make the check deny with `refused`; `cost` is outside rep's `orders.lines` columns
				const outcome = yield* act(route, t, rep.authority, 'orders.create', [
					{ number: 'COUNT', region: 'north', lines: [{ product: 'x', quantity: 1, cost: '1.00' }] }
				]);
				expect(outcome).toMatchObject({ kind: 'refused', code: 'forbidden', field: 'cost' });
				expect(outcome).not.toMatchObject({ code: 'refused' });
			})
		)
	);

	it.effect('a refusal refuses the whole batch at the row and field it names', () =>
		run(
			Effect.gen(function* () {
				const { t, route, rep } = yield* setup;
				expect(
					yield* act(route, t, rep.authority, 'orders.create', [
						{ number: 'OK', region: 'north', lines: [{ product: 'a', quantity: 1 }] },
						{ number: 'BAD', region: 'north', lines: [{ product: 'b', quantity: 0 }] }
					])
				).toMatchObject({
					kind: 'refused',
					code: 'refused',
					rule: 'rep.orders.create',
					row: 1,
					field: 'region'
				});
				const written = dynamic_read({ orders: { where: { number: { in: ['OK', 'BAD'] } } } });
				const writtenPage = yield* t.stored_query(written).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrderIds)));
				expect(writtenPage.orders.rows).toEqual([]);
				expect(
					yield* act(route, t, rep.authority, 'orders.delete', [{ target: { id: N1, revision: 1 } }])
				).toMatchObject({ kind: 'refused', code: 'refused', rule: 'rep.orders.delete' });
			})
		)
	);

	it.effect('`approve` holds the batch for its flow', () =>
		run(
			Effect.gen(function* () {
				const { t, route, rep } = yield* setup;
				expect(
					yield* act(route, t, rep.authority, 'orders.create', [
						{ number: 'BIG-1', region: 'north', lines: [{ product: 'a', quantity: 1 }] }
					])
				).toMatchObject({ kind: 'pending_approval', request_id: expect.any(String) });
				const plain = yield* act(route, t, rep.authority, 'orders.create', [
					{ number: 'SMALL', region: 'north', lines: [{ product: 'a', quantity: 1 }] }
				]);
				expect(plain).toMatchObject({ kind: 'committed' });
			})
		)
	);
});

