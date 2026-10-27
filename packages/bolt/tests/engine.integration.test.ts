// P2-INTEGRATE end to end on PGlite: the kit → engine entry → access, write, query, schema and guest areas together.
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Effect, Layer, Schema } from 'effect';
import { program } from './support/guest-fixture.ts';
import type { Authority, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import { TestWorkspace, type Kit, type WorkspaceServices } from '../src/test/index.ts';
import type { Json } from '../src/decl/values.ts';
import { actReply, qReply, routeFixture, type FixtureRoute } from './support/route-fixture.ts';
import { ACME, guest, manifest, seed, SHADY } from './engine-fixture.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const workspace = Layer.unwrap(
	program(guest.source).pipe(
		Effect.map((guest) =>
			TestWorkspace.layer({ manifest, guest, transforms: ['orders.create', 'orders.update'], seed })
		)
	)
);
const act = (
	route: FixtureRoute,
	t: Kit,
	authority: Authority,
	callable: string,
	input: Json,
	options: { key?: string; retry?: boolean } = {}
) =>
	actReply(
		route,
		authority,
		{ callable, input, issuedAt: t.clock.now() },
		{
			...(options.key === undefined ? {} : { 'Idempotency-Key': options.key }),
			...(options.retry ? { 'Idempotency-Retry': '1' } : {})
		}
	).pipe(Effect.map((reply) => reply.outcome));
const Row = Schema.Record(Schema.String, Schema.Json);
const Page = Schema.Struct({ rows: Schema.Array(Row), next: Schema.NullOr(Schema.String) });
/** One root's page through `/q`: the read request `{ [model]: layer }`, answered per root. */
const read = (route: FixtureRoute, authority: Authority, model: string, layer: Json = {}) =>
	qReply(route, authority, { reads: [{ m: 'query', a: [{ [model]: layer }] }] }).pipe(
		Effect.flatMap((reply) =>
			Schema.decodeUnknownEffect(Schema.Record(Schema.String, Page))(reply.answers[0])
		),
		Effect.map((answer) => present(answer[model]))
	);
/** One record by id as the caller reads it, or `null`. */
const get = (route: FixtureRoute, authority: Authority, model: string, id: string) =>
	read(route, authority, model, { where: { id: { eq: id } } }).pipe(
		Effect.map((page) => page.rows[0] ?? null)
	);
const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const idOf = (o: Outcome, c = 'orders') =>
	present(ok(o).records.find((r) => r.model === c)).id;
const writes = <A, E, R>(t: Kit, n: number, run: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const commits = vi.spyOn(t.db, 'transaction'),
			outcomes = vi.spyOn(t.db, 'returning');
		return yield* Effect.gen(function* () {
			const out = yield* run;
			const batches = commits.mock.calls.filter(([batch]) => batch.rollback !== true).length;
			const records = outcomes.mock.calls.filter(([, statement]) =>
				/\bAS outcome\b/.test(statement.text)
			).length;
			expect(batches + records).toBe(n);
			return out;
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					commits.mockRestore();
					outcomes.mockRestore();
				})
			)
		);
	});

describe('engine: create → read → update → delete through the full pipeline', () => {
	it.live('each act is one native batch; seq, roll-up, transform and state rules hold', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const rep = t.as(t.member(['rep']));
			const created = yield* writes(
				t,
				1,
				act(route, t, rep.authority, 'orders.create', [
					{
						title: '  desk ',
						region: 'north',
						customer: ACME,
						lines: [
							{ label: 'a', amount: '40' },
							{ label: 'b', amount: '10.50' }
						]
					}
				])
			);
			const id = idOf(created);
			expect(ok(created).records).toHaveLength(3);
			expect(yield* get(route, rep.authority, 'orders', id)).toMatchObject({
				title: 'desk',
				number: 'SO-0001',
				status: 'draft',
				total: { $dec: '50.50' }
			});

			const lines = (yield* read(route, rep.authority, 'lines', {
				where: { order: { eq: id } },
				orderBy: [{ label: 'asc' }],
				limit: 10
			})).rows;
			expect(lines.map((l) => l['label'])).toEqual(['a', 'b']);
			yield* writes(
				t,
				1,
				act(route, t, rep.authority, 'orders.update', [
					{
						target: id,
						set: {
							note: 'n',
							lines: { update: [{ target: String(present(lines[0])['id']), set: { amount: '1' } }] }
						}
					}
				]).pipe(Effect.map(ok))
			);
			expect(yield* get(route, rep.authority, 'orders', id)).toMatchObject({
				note: 'n',
				total: { $dec: '11.50' },
				revision: 2
			});

			yield* writes(
				t,
				1,
				act(route, t, rep.authority, 'orders.update', [
					{
						target: id,
						set: { status: 'submitted' }
					}
				]).pipe(Effect.map(ok))
			);
			expect(
				yield* act(route, t, rep.authority, 'orders.update', [{ target: id, set: { title: 'x' } }])
			).toMatchObject({ kind: 'refused', code: 'locked', field: 'title' });
			expect(
				yield* act(route, t, rep.authority, 'orders.update', [
					{
						target: id,
						set: { status: 'draft' }
					}
				])
			).toMatchObject({ kind: 'refused', code: 'forbidden', field: 'status' });

			yield* writes(
				t,
				1,
				act(route, t, rep.authority, 'orders.delete', [{ target: id }]).pipe(Effect.map(ok))
			);
			expect(yield* get(route, rep.authority, 'orders', id)).toBeNull();
			expect((yield* read(route, t.as(t.admin).authority, 'lines')).rows).toEqual([]);
		}).pipe(Effect.scoped, Effect.provide(workspace))
	);

	it.live('the transform reads as the workspace and refuses; its refusal is recorded once', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const rep = t.as(t.member(['rep']));
			const refused = yield* writes(
				t,
				1,
				act(
					route,
					t,
					rep.authority,
					'orders.create',
					[{ title: 'x', region: 'north', customer: SHADY }],
					{ key: 'k1' }
				)
			);
			expect(refused).toEqual({
				kind: 'refused',
				code: 'refused',
				message: 'Shady is blocked',
				field: 'customer',
				rule: 'orders.create'
			});
			expect(
				yield* writes(
					t,
					0,
					act(
						route,
						t,
						rep.authority,
						'orders.create',
						[{ title: 'x', region: 'north', customer: SHADY }],
						{ key: 'k1', retry: true }
					)
				)
			).toEqual(refused);
			expect((yield* read(route, t.as(t.admin).authority, 'orders')).rows).toEqual([]);
		}).pipe(Effect.scoped, Effect.provide(workspace))
	);

	it.live('an unmarked replay writes nothing and returns the first outcome byte for byte', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const rep = t.as(t.member(['rep']));
			const input = [{ title: 'desk', region: 'north', customer: ACME }];
			const first = yield* act(route, t, rep.authority, 'orders.create', input, { key: 'same' });
			const again = yield* act(route, t, rep.authority, 'orders.create', input, { key: 'same' });
			expect(JSON.stringify(again)).toBe(JSON.stringify(first));
			expect((yield* read(route, rep.authority, 'orders')).rows).toHaveLength(1);
			expect(
				yield* act(route, t, rep.authority, 'orders.create', [{ ...input, title: 'other' }], {
					key: 'same'
				})
			).toMatchObject({ kind: 'refused', code: 'keyReuse' });
			expect(
				yield* get(
					route,
					rep.authority,
					'orders',
					idOf(
						ok(yield* act(route, t, rep.authority, 'orders.create', [{ ...input, title: 'next' }]))
					)
				)
			).toMatchObject({ number: 'SO-0002' });
		}).pipe(Effect.scoped, Effect.provide(workspace))
	);
});

describe('engine: authority end to end (rules 13, 14, 35)', () => {
	it.live("scopes rows, masks fields per row, and rep's checks keep its writes in the north", () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const a = t.member(['rep']),
				b = t.member(['rep', 'auditor']);
			const mine = idOf(
				yield* act(route, t, t.as(a).authority, 'orders.create', [
					{
						title: 'a-order',
						region: 'north',
						note: 'secret',
						customer: ACME
					}
				])
			);
			const theirs = idOf(
				yield* act(route, t, t.as(b).authority, 'orders.create', [
					{
						title: 'b-order',
						region: 'north',
						note: 'visible',
						customer: ACME
					}
				])
			);

			expect((yield* read(route, t.as(a).authority, 'orders')).rows.map((r) => r['title'])).toEqual(
				['a-order']
			);
			expect(yield* get(route, t.as(a).authority, 'orders', theirs)).toBeNull();
			const seen = (yield* read(route, t.as(b).authority, 'orders', {
				orderBy: [{ title: 'asc' }]
			})).rows;
			expect(seen.map((r) => [r['title'], r['note']])).toEqual([
				['a-order', { $masked: true }],
				['b-order', 'visible']
			]);

			expect(
				yield* act(route, t, t.as(a).authority, 'orders.update', [
					{
						target: theirs,
						set: { note: 'x' }
					}
				])
			).toMatchObject({ kind: 'refused', code: 'notFound' });
			expect(
				yield* act(route, t, t.as(a).authority, 'orders.update', [
					{
						target: mine,
						set: { region: 'south' }
					}
				])
			).toMatchObject({
				kind: 'refused',
				code: 'refused',
				rule: 'rep.orders.update',
				field: 'region'
			});
			expect(
				yield* act(route, t, t.as(a).authority, 'orders.create', [
					{
						title: 'c',
						region: 'south',
						customer: ACME
					}
				])
			).toMatchObject({
				kind: 'refused',
				code: 'refused',
				rule: 'rep.orders.create',
				row: 0,
				field: 'region'
			});
			expect(
				yield* act(route, t, t.as(t.member(['auditor'])).authority, 'orders.update', [
					{
						target: mine,
						set: { note: 'x' }
					}
				])
			).toMatchObject({ kind: 'refused', code: 'forbidden' });
		}).pipe(Effect.scoped, Effect.provide(workspace))
	);

	it.live(
		"lines are their own access point: read through their order's owner, written under rep's lines check (rule 35)",
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const route = yield* routeFixture(
					yield* Effect.context<TestWorkspace | WorkspaceServices>()
				);
				const a = t.member(['rep']),
					b = t.member(['rep']);
				const id = idOf(
					yield* act(route, t, t.as(a).authority, 'orders.create', [
						{
							title: 'o',
							region: 'north',
							customer: ACME,
							lines: [{ label: 'l', amount: '5' }]
						}
					])
				);
				const [line] = (yield* read(route, t.as(a).authority, 'lines')).rows;
				expect((yield* read(route, t.as(b).authority, 'lines')).rows).toEqual([]);
				expect(
					yield* act(route, t, t.as(b).authority, 'lines.update', [
						{
							target: String(present(line)['id']),
							set: { amount: '6' }
						}
					])
				).toMatchObject({ code: 'notFound' });
				ok(
					yield* act(route, t, t.as(a).authority, 'lines.update', [
						{
							target: String(present(line)['id']),
							set: { amount: '7' }
						}
					])
				);
				expect(yield* get(route, t.as(a).authority, 'orders', id)).toMatchObject({
					total: { $dec: '7' }
				});
				ok(
					yield* act(route, t, t.as(t.admin).authority, 'orders.update', [
						{
							target: id,
							set: { region: 'south' }
						}
					])
				);
				expect(
					yield* act(route, t, t.as(a).authority, 'lines.update', [
						{
							target: String(present(line)['id']),
							set: { amount: '8' }
						}
					])
				).toMatchObject({ code: 'refused', rule: 'rep.lines.update' });
			}).pipe(Effect.scoped, Effect.provide(workspace))
	);

	it.live('an administrator bypasses grants but not the model or the transform', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const admin = t.as(t.admin);
			const id = idOf(
				yield* act(route, t, t.as(t.member(['rep'])).authority, 'orders.create', [
					{
						title: 'o',
						region: 'north',
						note: 'n',
						customer: ACME
					}
				])
			);
			expect(yield* get(route, admin.authority, 'orders', id)).toMatchObject({ note: 'n' });
			ok(
				yield* act(route, t, admin.authority, 'orders.update', [
					{
						target: id,
						set: { region: 'south', status: 'submitted' }
					}
				])
			);
			expect(
				yield* act(route, t, admin.authority, 'orders.update', [
					{ target: id, set: { title: 'y' } }
				])
			).toMatchObject({ code: 'locked', field: 'title' });
			expect(
				yield* act(route, t, admin.authority, 'orders.create', [
					{
						title: 'z',
						region: 'south',
						customer: SHADY
					}
				])
			).toMatchObject({ code: 'refused', field: 'customer' });
			expect(
				yield* act(route, t, admin.authority, 'orders.create', [
					{
						title: 'z',
						region: 'south',
						status: 'submitted',
						customer: ACME
					}
				])
			).toMatchObject({ code: 'invalidInput', field: 'status' });
		}).pipe(Effect.scoped, Effect.provide(workspace))
	);
});

describe('engine: guest walls (rules 71, 72)', () => {
	it.live(
		'a transform spinning past 2 s of CPU is stopped and refused; nothing is written but the outcome',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const route = yield* routeFixture(
					yield* Effect.context<TestWorkspace | WorkspaceServices>()
				);
				const started = Date.now();
				const o = yield* writes(
					t,
					1,
					act(route, t, t.as(t.admin).authority, 'orders.create', [
						{
							title: 'spin',
							region: 'north',
							customer: ACME
						}
					])
				);
				expect(o).toMatchObject({ kind: 'refused' });
				expect(o.kind === 'refused' ? o.message : undefined).toMatch(/2000 ms of guest CPU/);
				expect(Date.now() - started).toBeLessThan(5_000);
				expect((yield* read(route, t.as(t.admin).authority, 'orders')).rows).toEqual([]);
			}).pipe(Effect.scoped, Effect.provide(workspace)),
		10_000
	);
});

describe('engine: one atomic act stays inside the cell input budget', () => {
	it.live('refuses past the row and byte caps before it materializes the rows', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const rows = Array.from({ length: 4_001 }, (_, n) => ({
				title: `bulk-${n}`,
				region: 'north',
				customer: ACME
			}));
			expect(yield* act(route, t, t.as(t.admin).authority, 'orders.create', rows)).toMatchObject({
				kind: 'refused',
				code: 'overflow'
			});
			expect(
				yield* act(route, t, t.as(t.admin).authority, 'orders.create', [
					{
						title: 'x'.repeat(9 * 1024 * 1024),
						region: 'north',
						customer: ACME
					}
				])
			).toMatchObject({ kind: 'refused', code: 'overflow' });
			expect((yield* read(route, t.as(t.admin).authority, 'orders')).rows).toEqual([]);
		}).pipe(Effect.scoped, Effect.provide(workspace))
	);
});

describe('engine: declared record locks and enum transitions', () => {
	it.live('refuses an invalid enum move, then every write to a locked record', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const id = idOf(
				yield* act(route, t, t.as(t.admin).authority, 'orders.create', [
					{
						title: 'lock-check',
						region: 'north',
						customer: ACME
					}
				])
			);
			expect(
				yield* act(route, t, t.as(t.admin).authority, 'orders.update', [
					{
						target: id,
						set: { stage: 'lost' }
					}
				])
			).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'stage' });
			ok(
				yield* act(route, t, t.as(t.admin).authority, 'orders.update', [
					{
						target: id,
						set: { stage: 'won' }
					}
				])
			);
			ok(
				yield* act(route, t, t.as(t.admin).authority, 'orders.update', [
					{
						target: id,
						set: { archived: true }
					}
				])
			);
			expect(
				yield* act(route, t, t.as(t.admin).authority, 'orders.update', [
					{
						target: id,
						set: { title: 'changed' }
					}
				])
			).toMatchObject({ kind: 'refused', code: 'locked' });
			expect(
				yield* act(route, t, t.as(t.admin).authority, 'orders.delete', [{ target: id }])
			).toMatchObject({ kind: 'refused', code: 'locked' });
		}).pipe(Effect.scoped, Effect.provide(workspace))
	);
});
