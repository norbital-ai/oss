// Bulk writes cost the database a fixed number of trips: N rows (children, history, approval checkpoint included) take
// as many reads and write statements as one row, and an act commits in one write statement whatever N is.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import type { Sql } from '../src/engine/contracts.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';
import { dynamic_read } from '../src/protocol/read-request.ts';

/** An ad hoc manifest's acts: no generated callable names type them. */
const acts = (input: Readonly<Record<string, Json>>) => input;

const manifest: EngineManifest = {
	...base,
	models: {
		items: {
			description: 'Item',
			record_label: 'record.name',
			key: ['name'],
			unique: [{ fields: ['name'], name: 'items_name_key', import_key: true }],
			fields: { name: { kind: 'text' }, note: { kind: 'text', optional: true } }
		},
		parts: {
			description: 'Part',
			record_label: 'record.label',
			fields: { label: { kind: 'text' } }
		},
		notes: {
			description: 'Note',
			record_label: 'record.title',
			fields: { title: { kind: 'text' } }
		}
	},
	relationships: { 'parts.item': { to: 'items', inverse: 'parts', owned: true } },
	exposures: {
		items: {
			outputs: { default: { items: { fields: 'all' }, 'items.parts': { fields: 'all' } } },
			create: { columns: { items: ['name', 'note'], 'items.parts': ['label'] } },
			update: { columns: { items: ['name', 'note'], 'items.parts': ['label'] } },
			delete: {}
		},
		parts: { outputs: { default: { parts: { fields: 'all' } } } },
		notes: {
			outputs: { default: { notes: { fields: 'all' } } },
			create: { columns: { notes: ['title'] } }
		}
	},
	policies: {
		requester: {
			description: 'Requests item creation',
			grants: { items: { outputs: { default: {} }, create: { verdict: true } } }
		},
		reviewer: { description: 'Reviews', grants: { items: { outputs: { default: {} } } } }
	},
	teams: { Requesters: { policies: ['requester'] }, Reviewers: { policies: ['reviewer'] } }
};
const guest = program(`export default {
 policy:{requester:{grants:{items:{create:{verdict:function*(_rows,ctx){return ctx.approve({ steps: [{ name: 'Review', teams: ['Reviewers'] }] });}}}}}}
};`);

type Call = { kind: 'read' | 'write' | 'transaction'; statements: number; heads: string[]; sql: readonly Sql[] };
const fixture = Effect.gen(function* () {
	const calls: Call[] = [];
	const inner = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
	const head = (text: string) => text.replace(/\s+/g, ' ').slice(0, 90);
	const counted = TenantDb.typed({
		read: (statements) =>
			Effect.suspend(() => {
				calls.push({ kind: 'read', statements: statements.length, heads: statements.map((s) => head(s.text)), sql: statements });
				return inner.read(statements);
			}),
		write: (statement, lock) =>
			Effect.suspend(() => {
				calls.push({ kind: 'write', statements: 1, heads: [head(statement.text)], sql: [statement] });
				return inner.write(statement, lock);
			}),
		transaction: (batch) =>
			Effect.suspend(() => {
				calls.push({
					kind: 'transaction',
					statements: batch.statements.length,
					heads: batch.statements.map((s) => head(s.text)),
					sql: batch.statements
				});
				return inner.transaction(batch);
			})
	});
	const context = yield* Layer.build(
		TestWorkspace.layer({ manifest, guest: yield* guest, db: Layer.succeed(TenantDb, counted) })
	);
	const t = Context.get(context, TestWorkspace);
	const admin = yield* t.as(t.admin);
	const requester = yield* t.as(
		t.member(['requester'], { teams: ['Requesters'], team_path: ['Requesters'] })
	);
	yield* admin.query(dynamic_read({ items: {} }));
	/** Trips (calls) and statements one act costs, after background work goes quiet. */
	const measure = <A, E>(act: Effect.Effect<A, E>) =>
		Effect.gen(function* () {
			yield* t.settled();
			calls.length = 0;
			const started = performance.now();
			const answer = yield* act;
			const ms = Math.round(performance.now() - started);
			yield* t.settled();
			const taken = calls.splice(0);
			return {
				answer,
				ms,
				trips: taken.length,
				reads: taken.filter((c) => c.kind === 'read').length,
				writeStatements: taken
					.filter((c) => c.kind !== 'read')
					.reduce((n, c) => n + c.statements, 0),
				log: taken
			};
		});
	return { t, context, admin, requester, measure };
});
let tag = 0;
const items = (n: number) =>
	Array.from({ length: n }, () => {
		const i = tag++;
		return { name: `item ${i}`, note: 'n', parts: [{ label: `part ${i}a` }, { label: `part ${i}b` }] };
	});
type Measured = { trips: number; reads: number; writeStatements: number; ms: number; log: Call[] };
const Target = Schema.Struct({ id: Schema.String, revision: Schema.Number });
type Admin = Effect.Success<typeof fixture>['admin'];
const ids = (admin: Admin, names: readonly string[]) =>
	admin.query(dynamic_read({ items: { where: { name: { in: [...names] } }, limit: 200 } })).pipe(
		Effect.map((answer) => {
			const page = answer.items;
			if (page === undefined || !('rows' in page)) throw new Error('No items page');
			return page.rows.map((row) => Schema.decodeUnknownSync(Target)(row));
		})
	);
const both = (label: string, run: (n: number) => Effect.Effect<Measured, unknown>, n = 50) =>
	Effect.gen(function* () {
		const one = yield* run(1),
			many = yield* run(n);
		expect(many.writeStatements, `${label}: one write statement per act`).toBe(1);
		expect(many.trips, `${label}: trips(${n}) === trips(1)`).toBe(one.trips);
	});

it.live('create of N rows with owned children costs what one row costs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* both('create', (n) => f.measure(f.admin.act(acts({ 'items.create': items(n) }))));
			// the same statements wrote every row's history: 51 items and their 102 parts
			const history = (model: string) =>
				f.t.db.value(Schema.Number, {
					text: 'SELECT count(*)::int FROM bolt_history WHERE collection = $1',
					params: [model]
				});
			expect([yield* history('items'), yield* history('parts')]).toEqual([51, 102]);
		})
	)
);
it.live('update of N rows costs what one row costs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* both('update', (n) =>
				Effect.gen(function* () {
					const rows = items(n);
					yield* f.admin.act(acts({ 'items.create': rows }));
					const targets = yield* ids(f.admin, rows.map((r) => r.name));
					return yield* f.measure(
						f.admin.act(acts({ 'items.update': targets.map((target) => ({ target, set: { note: 'changed' } })) }))
					);
				})
			);
		})
	)
);
it.live('delete of N rows (cascading their children) costs what one row costs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* both('delete', (n) =>
				Effect.gen(function* () {
					const rows = items(n);
					yield* f.admin.act(acts({ 'items.create': rows }));
					const targets = yield* ids(f.admin, rows.map((r) => r.name));
					return yield* f.measure(f.admin.act(acts({ 'items.delete': targets.map((target) => ({ target })) })));
				})
			);
		})
	)
);
it.live('import of N rows (half new, half matched) costs what one row costs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* both('import', (n) =>
				Effect.gen(function* () {
					// N=1 is one matched and one new row, so both runs take the same import paths
					const existing = items(Math.max(1, Math.floor(n / 2))).map(({ name }) => ({ name, note: 'old' }));
					yield* f.admin.act(acts({ 'items.create': existing }));
					const fresh = items(Math.max(1, n - existing.length)).map(({ name }) => ({ name, note: 'new' }));
					const rows: Json[] = [...existing.map((r) => ({ ...r, note: 'imported' })), ...fresh];
					return yield* f.measure(f.admin.act(acts({ 'items.import': { rows, on_conflict: 'update' } })));
				})
			);
		})
	)
);
it.live('a write routed to approval of N rows costs what one row costs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* both('approval', (n) =>
				Effect.gen(function* () {
					const m = yield* f.measure(f.requester.act(acts({ 'items.create': items(n) })));
					expect(m.answer).toMatchObject({ kind: 'pending_approval' });
					// the checkpoint holds every created row, written by the same statements
					const held = yield* f.t.db.value(Schema.Number, {
						text: 'SELECT jsonb_array_length(records)::int FROM bolt_approvals WHERE id::text = $1',
						params: [Schema.decodeUnknownSync(Schema.Struct({ request_id: Schema.String }))(m.answer).request_id]
					});
					expect(held).toBeGreaterThanOrEqual(n);
					return m;
				})
			);
		})
	)
);
const bytes = (text: string) => Buffer.byteLength(text);
/** The SQL text of the commit's write statements: what must not grow with the rows it carries. */
const text = (log: readonly Call[]) =>
	log.filter((c) => c.kind !== 'read').flatMap((c) => c.sql).reduce((n, s) => n + bytes(s.text), 0);
it.live('a bulk create is one write statement whose SQL text does not grow with its rows', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			// the first act has no earlier audit acknowledgements to carry; compare acts that both do
			yield* f.admin.act(acts({ 'items.create': items(1) }));
			const one = yield* f.measure(f.admin.act(acts({ 'items.create': items(1) })));
			const many = yield* f.measure(f.admin.act(acts({ 'items.create': items(100) })));
			expect(one.writeStatements).toBe(1);
			expect(many.writeStatements).toBe(1);
			expect(many.trips).toBe(one.trips);
			expect(text(many.log)).toBe(text(one.log));
		})
	)
);
