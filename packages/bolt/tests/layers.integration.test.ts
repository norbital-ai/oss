// P2/P3 gates end to end on PGlite (decisions 3, 6, 8): authority is per access point. A root's policy alone filters
// and masks its read layers; a layer model's own grants are never consulted; a model without `read` is a layer, never
// a root; a user `where` only narrows. Writes are batches: `columns` are admitted before any guest code, then ONE
// `check` per verb judges the whole batch tree; `deny` refuses it, `approve` holds it.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, type Scope } from 'effect';
import type { Authority } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { dynamicRead } from '../src/protocol/read-request.ts';
import { TestWorkspace, type Kit, type WorkspaceServices } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture, type FixtureRoute } from './support/route-fixture.ts';

const ACME = '0199a000-0000-4000-8000-0000000000a1';
const N1 = '0199a000-0000-4000-8000-0000000000b1',
	N2 = '0199a000-0000-4000-8000-0000000000b2',
	S1 = '0199a000-0000-4000-8000-0000000000b3';
const L0 = '0199a000-0000-4000-8000-0000000000c1',
	L5 = '0199a000-0000-4000-8000-0000000000c2',
	M0 = '0199a000-0000-4000-8000-0000000000c3',
	T5 = '0199a000-0000-4000-8000-0000000000c4';

const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		// no `read`: stored, and a layer of orders, never a root
		parties: {
			description: 'A party',
			label: 'name',
			fields: {
				name: { kind: 'text' },
				code: { kind: 'text' },
				credit_limit: { kind: 'decimal', scale: 2 }
			}
		},
		orders: {
			description: 'An order',
			label: 'number',
			fields: {
				number: { kind: 'text' },
				region: { kind: 'enum', values: ['north', 'south'] },
				status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' }
			}
		},
		order_lines: {
			description: 'A line',
			label: 'product',
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
			read: {
				orders: { fields: 'all' },
				'orders.party': { fields: ['name', 'code', 'credit_limit'] },
				'orders.lines': { fields: 'all' }
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
		order_lines: { read: { order_lines: { fields: 'all' } } }
	},
	integrations: {},
	policies: {
		rep: {
			description: 'Northern sales, through the order tree',
			grants: {
				orders: {
					read: {
						orders: { where: { region: { eq: 'north' } } },
						'orders.party': { fields: ['name', 'code'] },
						'orders.lines': { where: { cost: { gt: 0 } } }
					},
					create: {
						columns: {
							orders: ['number', 'region', 'status', 'party'],
							'orders.lines': ['product', 'quantity']
						},
						check: true
					},
					update: { check: true },
					delete: { check: true }
				}
			}
		},
		reviewer: { description: 'Finance', grants: { orders: { read: true } } }
	},
	teams: { finance: ['reviewer'], sales: ['rep'] },
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
/** `rep`'s checks: `COUNT` answers the batch it judged (rows, nested lines), a non-positive quantity is denied at its
 * path, a `BIG` order is approved by finance; an update needs a draft with lines; a delete is always denied. */
const source = `export default { policy: { rep: { grants: { orders: {
	create: { check: function* (rows, ctx) {
		const lines = rows.flatMap((r) => r.lines ?? []);
		if (rows.some((r) => r.number === 'COUNT')) return ctx.deny('rows:' + rows.length + ';lines:' + lines.length);
		const row = rows.findIndex((r) => (r.lines ?? []).some((l) => typeof l !== 'string' && l.quantity <= 0));
		if (row >= 0) return ctx.deny('Quantities must be positive.', { row, path: 'orders.lines', field: 'quantity' });
		if (rows.some((r) => r.number.startsWith('BIG'))) return ctx.approve((flow) => flow.step('Finance', { teams: ['finance'] }));
		return ctx.allow();
	} },
	update: { check: function* (changes, ctx) {
		const row = changes.findIndex((c) => c.before.status !== 'draft' || c.before.lines.length === 0);
		return row >= 0 ? ctx.deny('Only a draft with lines changes.', { row }) : ctx.allow();
	} },
	delete: { check: function* (rows, ctx) { return ctx.deny('Reps never delete.'); } }
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
	const route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
	return { t, route, rep: t.as(t.member(['rep'], { teams: ['sales'] })) };
});
const act = (route: FixtureRoute, t: Kit, who: Authority, callable: string, input: Json) =>
	actReply(route, who, { callable, input, issuedAt: t.clock.now() }).pipe(
		Effect.map((reply) => reply.outcome)
	);
/** A raw `/q` read: what a page or another host could put on the wire, typed or not. */
const raw = (route: FixtureRoute, who: Authority, request: Json) =>
	qReply(route, who, { reads: [{ m: 'query', a: [request] }] });
const ids = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id);
const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope | TestWorkspace | WorkspaceServices>) =>
	body.pipe(Effect.scoped, Effect.provide(workspace));

describe('read layers: one access point, the root policy alone', () => {
	it.live('the root `where` filters roots; a user `where` narrows it and never widens it', () =>
		run(
			Effect.gen(function* () {
				const { rep } = yield* setup;
				const all = dynamicRead({ orders: { orderBy: 'number' } });
				expect(ids((yield* rep.query(all)).orders?.rows ?? [])).toEqual([N1, N2]);
				const south = dynamicRead({ orders: { where: { region: { eq: 'south' } } } });
				expect((yield* rep.query(south)).orders?.rows).toEqual([]);
				const either = dynamicRead({
					orders: {
						where: { or: [{ region: { eq: 'south' } }, { region: { eq: 'north' } }] },
						orderBy: 'number'
					}
				});
				expect(ids((yield* rep.query(either)).orders?.rows ?? [])).toEqual([N1, N2]);
			})
		)
	);

	it.live(
		'a layer row shows with no grant on its model; reading that model as a root is its own access point',
		() =>
			run(
				Effect.gen(function* () {
					const { rep } = yield* setup;
					const tree = dynamicRead({
						orders: { where: { number: { eq: 'N1' } } },
						'orders.lines': {}
					});
					const [order] = (yield* rep.query(tree)).orders?.rows ?? [];
					expect(order).toMatchObject({ id: N1, lines: [{ id: L5, product: 'paid' }] });
					const lines = dynamicRead({ order_lines: {} });
					expect(yield* Effect.flip(rep.query(lines))).toMatchObject({ code: 'forbidden' });
				})
			)
	);

	it.live('a model without `read` is a layer, refused as a root', () =>
		run(
			Effect.gen(function* () {
				const { rep } = yield* setup;
				const layer = dynamicRead({
					orders: { where: { number: { eq: 'N1' } }, fields: ['number', 'party'] },
					'orders.party': {}
				});
				expect((yield* rep.query(layer)).orders?.rows).toMatchObject([
					{ id: N1, number: 'N1', party: { id: ACME, name: 'Acme', code: 'AC' } }
				]);
				const root = dynamicRead({ parties: {} });
				const refused = yield* Effect.flip(rep.query(root));
				expect(refused.message).toContain('no read root');
			})
		)
	);

	it.live(
		'a layer `where` filters only that layer: a list shrinks, a ref nulls, the root stays',
		() =>
			run(
				Effect.gen(function* () {
					const { rep } = yield* setup;
					// the policy's `orders.lines` where (cost > 0) drops free lines, never the order that holds them
					const lines = dynamicRead({ orders: { orderBy: 'number' }, 'orders.lines': {} });
					expect(
						((yield* rep.query(lines)).orders?.rows ?? []).map((o) => [
							o['id'],
							ids(rowsOf(o['lines']))
						])
					).toEqual([
						[N1, [L5]],
						[N2, []]
					]);
					// a user layer where narrows the policy's further, still per layer
					const narrower = dynamicRead({
						orders: { orderBy: 'number' },
						'orders.lines': { where: { quantity: { gt: 2 } } }
					});
					expect(
						((yield* rep.query(narrower)).orders?.rows ?? []).map((o) => [
							o['id'],
							ids(rowsOf(o['lines']))
						])
					).toEqual([
						[N1, []],
						[N2, []]
					]);
					const ref = dynamicRead({
						orders: { orderBy: 'number', fields: ['number', 'party'] },
						'orders.party': { where: { code: { eq: 'ZZ' } } }
					});
					expect((yield* rep.query(ref)).orders?.rows).toMatchObject([
						{ id: N1, party: null },
						{ id: N2, party: null }
					]);
				})
			)
	);

	it.live('a field the root policy narrows away stays masked in its layer, even when named', () =>
		run(
			Effect.gen(function* () {
				const { t, rep } = yield* setup;
				const named = dynamicRead({
					orders: { where: { number: { eq: 'N1' } }, fields: ['party'] },
					'orders.party': { fields: ['name', 'credit_limit'] }
				});
				expect((yield* rep.query(named)).orders?.rows).toMatchObject([
					{ party: { name: 'Acme', credit_limit: { $masked: true } } }
				]);
				// a caller without that narrowing reads it
				expect(
					(yield* t.as(t.member(['reviewer'])).query(named)).orders?.rows[0]?.['party']
				).not.toMatchObject({ credit_limit: { $masked: true } });
			})
		)
	);

	it.live(
		'the wire refuses an unknown option, a path outside the declaration and a sixth level',
		() =>
			run(
				Effect.gen(function* () {
					const { route, rep } = yield* setup;
					for (const request of [
						{ orders: { nope: 1 } },
						{ orders: {}, 'orders.customer': {} },
						{ 'orders.lines.order.lines.order.lines': {} },
						{ orders: {}, 'orders.lines': { asOf: '2026-01-01T00:00:00Z' } }
					])
						expect(yield* Effect.flip(raw(route, rep.authority, request))).toMatchObject({
							_tag: 'ReadFailed'
						});
				})
			)
	);
});

describe('write layers: columns first, then one check over the batch', () => {
	it.live('a column outside the grant`s columns is refused before `check` runs', () =>
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

	it.live('`check` sees the whole batch, nested layers included, in one call', () =>
		run(
			Effect.gen(function* () {
				const { t, route, rep } = yield* setup;
				expect(
					yield* act(route, t, rep.authority, 'orders.create', [
						{ number: 'COUNT', region: 'north', lines: [{ product: 'a', quantity: 1 }] },
						{
							number: 'B',
							region: 'north',
							lines: [
								{ product: 'b', quantity: 1 },
								{ product: 'c', quantity: 1 }
							]
						}
					])
				).toMatchObject({
					kind: 'refused',
					code: 'refused',
					message: 'rows:2;lines:3',
					rule: 'rep.orders.create'
				});
				// an update's `before` is the stored tree of the declared update layers
				expect(
					yield* act(route, t, rep.authority, 'orders.update', [
						{ target: N1, set: { status: 'sent' } }
					])
				).toMatchObject({ kind: 'committed' });
			})
		)
	);

	it.live('`deny` refuses the whole batch at the row, path and field it names', () =>
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
					path: 'orders.lines',
					field: 'quantity'
				});
				const written = dynamicRead({ orders: { where: { number: { in: ['OK', 'BAD'] } } } });
				expect((yield* t.storedQuery(written)).orders?.rows).toEqual([]);
				expect(
					yield* act(route, t, rep.authority, 'orders.delete', [{ target: N1 }])
				).toMatchObject({ kind: 'refused', code: 'refused', rule: 'rep.orders.delete' });
			})
		)
	);

	it.live('`approve` holds the batch for its flow', () =>
		run(
			Effect.gen(function* () {
				const { t, route, rep } = yield* setup;
				expect(
					yield* act(route, t, rep.authority, 'orders.create', [
						{ number: 'BIG-1', region: 'north', lines: [{ product: 'a', quantity: 1 }] }
					])
				).toMatchObject({ kind: 'pendingApproval', requestId: expect.any(String) });
				const plain = yield* act(route, t, rep.authority, 'orders.create', [
					{ number: 'SMALL', region: 'north', lines: [{ product: 'a', quantity: 1 }] }
				]);
				expect(plain).toMatchObject({ kind: 'committed' });
			})
		)
	);
});

/** A many-layer's rows off a dynamic answer's row. */
function rowsOf(value: Json | undefined): readonly { readonly id: string }[] {
	return Array.isArray(value)
		? value.flatMap((row) =>
				typeof row === 'object' &&
				row !== null &&
				!Array.isArray(row) &&
				typeof row['id'] === 'string'
					? [{ id: row['id'] }]
					: []
			)
		: [];
}
