// P2-INTEGRATE end to end on PGlite: the kit → engine entry → access, write, query, schema and guest areas together.
// One workspace, its tests in order (the first order is SO-0001); each later test reads only the rows it wrote. The guest
// CPU wall is guest.test's.
import { expect, layer } from '@effect/vitest';
import { vi } from 'vitest';
import { Effect, Layer, Schema } from 'effect';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { LIMITS, type Authority, type ActOutcome as Outcome } from '../src/engine/contracts.ts';
import { TestWorkspace, type Kit, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';
import type { Json } from '../src/decl/values.ts';
import { act_reply, q_reply, route_fixture, type FixtureRoute } from './support/route-fixture.ts';
import { ACME, guest, manifest, seed } from './engine-fixture.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const workspace = Layer.unwrap(
	program(guest.source).pipe(
		Effect.map((guest) =>
			TestWorkspace.layer({
				manifest,
				guest,
				transforms: ['orders.create', 'orders.update'],
				seed
			})
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
	act_reply(
		route,
		authority,
		{ acts: { [callable]: input }, issued_at: t.clock.now() },
		{
			...(options.key === undefined ? {} : { 'Idempotency-Key': options.key }),
			...(options.retry ? { 'Idempotency-Retry': '1' } : {})
		}
	).pipe(Effect.map((reply) => reply.outcome));
const Row = Schema.Record(Schema.String, Schema.Json);
const Page = Schema.Struct({ rows: Schema.Array(Row), next: Schema.NullOr(Schema.String) });
/** One root's page through `/q`: the read request `{ [model]: layer }`, answered per root. */
const read = (route: FixtureRoute, authority: Authority, model: string, layer: Json = {}) =>
	q_reply(route, authority, { reads: [{ m: 'query', a: [{ [model]: layer }] }] }).pipe(
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
const idOf = (o: Outcome, c = 'orders') => present(ok(o).records.find((r) => r.model === c)).id;
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

const count = (route: FixtureRoute, t: Kit) =>
	t.as(t.admin).pipe(
		Effect.flatMap((admin) => read(route, admin.authority, 'orders')),
		Effect.map((page) => page.rows.length)
	);

layer(workspace, { excludeTestServices: true })('engine', (it) => {
	// engine: create → read → update → delete through the full pipeline
	it.effect('each act is one native batch; seq, roll-up, transform and state rules hold', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* route_fixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const rep = yield* t.as(t.member(['rep']));
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
				order_by: [{ label: 'asc' }],
				limit: 10
			})).rows;
			expect(lines.map((l) => l['label'])).toEqual(['a', 'b']);
			yield* writes(
				t,
				1,
				act(route, t, rep.authority, 'orders.update', [
					{
						target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)),
						set: {
							note: 'n',
							lines: { update: [{ target: present(lines[0]), set: { amount: '1' } }] }
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
						target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)),
						set: { status: 'submitted' }
					}
				]).pipe(Effect.map(ok))
			);
			// a submitted order is locked against deletion; the administrator's move back to draft releases it
			const admin = (yield* t.as(t.admin)).authority;
			const current = () => get(route, admin, 'orders', id);
			expect(
				yield* act(route, t, rep.authority, 'orders.delete', [{ target: present(yield* current()) }])
			).toMatchObject({ kind: 'refused', code: 'locked' });
			yield* writes(
				t,
				1,
				act(route, t, admin, 'orders.update', [
					{ target: present(yield* current()), set: { status: 'draft' } }
				]).pipe(Effect.map(ok))
			);
			yield* writes(
				t,
				1,
				act(route, t, rep.authority, 'orders.delete', [{ target: present(yield* current()) }]).pipe(Effect.map(ok))
			);
			expect(yield* get(route, rep.authority, 'orders', id)).toBeNull();
			expect((yield* read(route, (yield* t.as(t.admin)).authority, 'lines')).rows).toEqual([]);
		}).pipe(Effect.scoped)
	);

	// engine: authority end to end
	it.effect(
		"scopes rows per output, an output fixes its fields, and rep's checks keep its writes in the north",
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const route = yield* route_fixture(
					yield* Effect.context<TestWorkspace | WorkspaceServices>()
				);
				const a = t.member(['rep']),
					b = t.member(['rep', 'auditor']);
				const mine = idOf(
					yield* act(route, t, (yield* t.as(a)).authority, 'orders.create', [
						{
							title: 'a-order',
							region: 'north',
							note: 'secret',
							customer: ACME
						}
					])
				);
				const theirs = idOf(
					yield* act(route, t, (yield* t.as(b)).authority, 'orders.create', [
						{
							title: 'b-order',
							region: 'north',
							note: 'visible',
							customer: ACME
						}
					])
				);

				expect(
					(yield* read(route, (yield* t.as(a)).authority, 'orders')).rows.map((r) => r['title'])
				).toEqual(['a-order']);
				expect(yield* get(route, (yield* t.as(a)).authority, 'orders', theirs)).toBeNull();
				// rep's `default` output: its own rows, every field; the auditor's `audit` output: every row, never `note`
				const own = (yield* read(route, (yield* t.as(b)).authority, 'orders', {
					order_by: [{ title: 'asc' }]
				})).rows;
				expect(own.map((r) => [r['title'], r['note']])).toEqual([['b-order', 'visible']]);
				const audited = (yield* read(route, (yield* t.as(b)).authority, 'orders', {
					output: 'audit',
					order_by: [{ title: 'asc' }]
				})).rows;
				expect(audited.map((r) => r['title'])).toEqual(['a-order', 'b-order']);
				expect(audited.every((r) => !('note' in r))).toBe(true);
				// an aggregate names its output too: the auditor counts every row
				const counted = yield* q_reply(route, (yield* t.as(b)).authority, {
					reads: [{ m: 'aggregate', a: ['orders', { count: true, output: 'audit' }] }]
				});
				expect(counted.answers[0]).toMatchObject({ count: 2 });

				expect(
					yield* act(route, t, (yield* t.as(a)).authority, 'orders.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', theirs)),
							set: { note: 'x' }
						}
					])
				).toMatchObject({ kind: 'refused', code: 'not_found' });
				expect(
					yield* act(route, t, (yield* t.as(a)).authority, 'orders.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', mine)),
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
					yield* act(route, t, (yield* t.as(a)).authority, 'orders.create', [
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
					yield* act(route, t, (yield* t.as(t.member(['auditor']))).authority, 'orders.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', mine)),
							set: { note: 'x' }
						}
					])
				).toMatchObject({ kind: 'refused', code: 'forbidden' });
			}).pipe(Effect.scoped)
	);

	it.effect(
		"lines are their own access point: read through their order's owner, written under rep's lines check",
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const route = yield* route_fixture(
					yield* Effect.context<TestWorkspace | WorkspaceServices>()
				);
				const a = t.member(['rep']),
					b = t.member(['rep']);
				const id = idOf(
					yield* act(route, t, (yield* t.as(a)).authority, 'orders.create', [
						{
							title: 'o',
							region: 'north',
							customer: ACME,
							lines: [{ label: 'l', amount: '5' }]
						}
					])
				);
				const [line] = (yield* read(route, (yield* t.as(a)).authority, 'lines')).rows;
				expect((yield* read(route, (yield* t.as(b)).authority, 'lines')).rows).toEqual([]);
				expect(
					yield* act(route, t, (yield* t.as(b)).authority, 'lines.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'lines', String(present(line)['id']))),
							set: { amount: '6' }
						}
					])
				).toMatchObject({ code: 'not_found' });
				ok(
					yield* act(route, t, (yield* t.as(a)).authority, 'lines.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'lines', String(present(line)['id']))),
							set: { amount: '7' }
						}
					])
				);
				expect(yield* get(route, (yield* t.as(a)).authority, 'orders', id)).toMatchObject({
					total: { $dec: '7' }
				});
				ok(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)),
							set: { region: 'south' }
						}
					])
				);
				expect(
					yield* act(route, t, (yield* t.as(a)).authority, 'lines.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'lines', String(present(line)['id']))),
							set: { amount: '8' }
						}
					])
				).toMatchObject({ code: 'refused', rule: 'rep.lines.update' });
			}).pipe(Effect.scoped)
	);

	// engine: one atomic act stays inside the cell input budget (the byte cap is the same pre-flattener check)
	it.effect('refuses past the row cap before it materializes the rows', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* route_fixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const before = yield* count(route, t);
			const rows = Array.from({ length: LIMITS.act.rows + 1 }, (_, n) => ({
				title: `bulk-${n}`,
				region: 'north',
				customer: ACME
			}));
			expect(yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.create', rows)).toMatchObject({
				kind: 'refused',
				code: 'overflow'
			});
			expect(yield* count(route, t)).toBe(before);
		}).pipe(Effect.scoped)
	);

	// engine: declared record locks and enum transitions
	it.effect(
		'refuses an invalid enum move, then every change to a locked record (restating it is no write)',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const route = yield* route_fixture(
					yield* Effect.context<TestWorkspace | WorkspaceServices>()
				);
				const id = idOf(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.create', [
						{
							title: 'lock-check',
							region: 'north',
							customer: ACME
						}
					])
				);
				expect(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)),
							set: { stage: 'lost' }
						}
					])
				).toMatchObject({ kind: 'refused', code: 'invalid_input', field: 'stage' });
				ok(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)),
							set: { stage: 'won' }
						}
					])
				);
				expect(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.update', [
						{ target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)), set: { title: 'locked after winning' } }
					])
				).toMatchObject({ kind: 'refused', code: 'locked', field: 'title' });
				ok(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.update', [
						{ target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)), set: { note: 'still editable' } }
					])
				);
				ok(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)),
							set: { archived: true }
						}
					])
				);
				expect(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.update', [
						{
							target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)),
							set: { note: 'locked after archiving' }
						}
					])
				).toMatchObject({ kind: 'refused', code: 'locked' });
				// restating the locked row changes nothing: no write, no refusal (an unchanged re-import)
				ok(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.update', [
						{ target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)), set: { stage: 'won', archived: true } }
					])
				);
				expect(
					yield* act(route, t, (yield* t.as(t.admin)).authority, 'orders.delete', [{ target: present(yield* get(route, (yield* t.as(t.admin)).authority, 'orders', id)) }])
				).toMatchObject({ kind: 'refused', code: 'locked' });
			}).pipe(Effect.scoped)
	);
});
