// A write callback may carry rows of other models into its own commit, as owned children are: they run their own
// callbacks, the root write's grant admits them, and they commit with the write or not at all.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { admin, authority, grants, manifest as base, NOW, TODAY } from './write-fixture.ts';
import { open } from './write-p2.fixture.ts';

const orders = base.exposures.orders,
	tags = base.exposures.tags;
if (orders === undefined || tags === undefined) throw new Error('the write fixture lost a model');
const manifest: EngineManifest = {
	...base,
	exposures: {
		...base.exposures,
		orders: {
			...orders,
			...(orders.create === undefined ? {} : { create: { ...orders.create, transform: true } }),
			...(orders.update === undefined ? {} : { update: { ...orders.update, transform: true } })
		},
		tags: {
			...tags,
			...(tags.create === undefined ? {} : { create: { ...tags.create, transform: true } })
		}
	}
};
const Row = Schema.Record(Schema.String, Schema.Json);
const Changes = Schema.Array(Schema.Struct({ before: Schema.NullOr(Row), set: Row, after: Row }));
/** What the orders callbacks carry, set by each case. */
let carry: (rows: readonly (typeof Row.Type)[]) => { readonly [key: string]: Json } = () => ({});
const setup = Effect.gen(function* () {
	const { db } = yield* open(manifest);
	let serial = 0,
		commits = 0;
	const engine: WriteEngine = {
		manifest,
		db: {
			...db,
			transaction: (batch) =>
				Effect.suspend(() => {
					if (batch.rollback !== true) commits++;
					return db.transaction(batch);
				})
		},
		guest: {
			invokeProgram: () => Effect.die('This fixture executes native write callbacks only.'),
			invoke: (invocation) =>
				Effect.gen(function* () {
                    const changes = yield* Schema.decodeUnknownEffect(Changes)(invocation.input).pipe(Effect.orDie);
                    const rows = changes.map(({ set }) => set);
					if (invocation.target === 'tags') {
						if (rows.some((row) => row['name'] === 'refuse'))
							return { kind: 'refused' as const, message: 'This tag refuses.' };
						return {
							kind: 'ok' as const,
							output: rows.map((row) => ({ ...row, name: String(row['name']).toUpperCase() }))
						};
					}
					// only a root create carries: the rows it carries would otherwise carry again, level after level
					return {
						kind: 'ok' as const,
						output: { sets: rows, ...(invocation.kind === 'create' ? carry(changes.map(({ after }) => after)) : {}) }
					};
				})
		}
	};
	const run = (request: Pick<ActRequest, 'verb' | 'input'> & Partial<ActRequest>) =>
		act(engine, {
			model: 'orders',
			mode: { _tag: 'Direct' },
			key: `carried-${serial}`,
			invocationId: `carried-${serial++}`,
			issuedAt: NOW,
			authority: admin,
			bindings: { now: NOW, today: TODAY, tz: 'UTC' },
			...request
		});
	const names = db
		.rows(Schema.Struct({ name: Schema.String }), {
			text: 'SELECT name FROM tags ORDER BY name',
			params: []
		})
		.pipe(Effect.map((rows) => rows.map((row) => row.name)));
	const order = (title: string) =>
		db
			.rows(
				Schema.Struct({
					id: Schema.String,
					note: Schema.NullOr(Schema.String),
					revision: Schema.Number
				}),
				{
					text: 'SELECT id, note, revision FROM orders WHERE title = $1',
					params: [title]
				}
			)
			.pipe(Effect.map((rows) => rows[0]));
	return { run, names, order, commits: () => commits };
});
const committed = (result: Effect.Success<ReturnType<typeof act>>) => {
	if (result.outcome.kind !== 'committed') throw new Error(JSON.stringify(result.outcome));
	return result.outcome.records;
};

describe('a write that carries other models', () => {
	it.effect('commits what it carries in its own statement, after their own callbacks', () =>
		Effect.gen(function* () {
			const { run, names, commits } = yield* setup;
			carry = (rows) => ({
				with: { tags: { create: rows.map((row) => ({ name: `for ${String(row['title'])}` })) } }
			});
			const records = committed(yield* run({ verb: 'create', input: [{ title: 'desk' }] }));
			expect(commits()).toBe(1);
			expect(yield* names).toEqual(['FOR DESK']);
			expect(records.map((record) => record.model).toSorted()).toEqual(['orders', 'tags']);
		})
	);

	it.effect('reads the id each created row will have', () =>
		Effect.gen(function* () {
			const { run, names, order } = yield* setup;
			carry = (rows) => ({
				with: { tags: { create: rows.map((row) => ({ name: String(row['id']) })) } }
			});
			committed(yield* run({ verb: 'create', input: [{ title: 'crate' }] }));
			const crate = yield* order('crate');
			expect(yield* names).toEqual([crate?.id.toUpperCase()]);
		})
	);

	it.effect('commits nothing when a carried row is refused', () =>
		Effect.gen(function* () {
			const { run, names, order } = yield* setup;
			carry = () => ({ with: { tags: { create: [{ name: 'refuse' }] } } });
			const result = yield* run({ verb: 'create', input: [{ title: 'chair' }] });
			expect(result.outcome).toMatchObject({ kind: 'refused', message: 'This tag refuses.' });
			expect(yield* order('chair')).toBeUndefined();
			expect(yield* names).toEqual([]);
		})
	);

	it.effect('updates another row at the revision it read, and conflicts on a newer one', () =>
		Effect.gen(function* () {
			const { run, order } = yield* setup;
			carry = () => ({});
			committed(yield* run({ verb: 'create', input: [{ title: 'shelf' }] }));
			const shelf = yield* order('shelf');
			if (shelf === undefined) return yield* Effect.die('no shelf');
			carry = () => ({
				with: {
					orders: {
						update: [{ target: shelf, set: { note: 'counted' } }]
					}
				}
			});
			committed(yield* run({ verb: 'create', input: [{ title: 'lamp' }] }));
			expect((yield* order('shelf'))?.note).toBe('counted');
			// the same revision again is now stale: the whole write is a conflict, and the lamp's sibling never lands
			const stale = yield* run({ verb: 'create', input: [{ title: 'rug' }] });
			expect(stale.outcome).toMatchObject({ kind: 'conflict' });
			expect(yield* order('rug')).toBeUndefined();
		})
	);

	it.live('an atomic map can delete a row and create its replacement record together', () =>
        Effect.scoped(Effect.gen(function* () {
            const context = yield* Layer.build(TestWorkspace.layer({ manifest: base }));
            const t = Context.get(context, TestWorkspace);
            const acts = yield* t.body_acts(t.admin);
            const write = (input: Readonly<Record<string, Json>>) => acts(input);
            const made = yield* write({ 'orders.create': [{ title: 'stool' }] });
            if (made.kind !== 'committed') throw new Error('The stool must commit.');
            const stool = yield* t.db.value(Schema.Struct({ id: Schema.String, revision: Schema.Number }), {
                text: "SELECT jsonb_build_object('id',id,'revision',revision) FROM orders WHERE title='stool'", params: []
            });
            expect(yield* write({
                'orders.delete': [{ target: stool }],
                'tags.create': [{ name: 'stool gone' }]
            })).toMatchObject({ kind: 'committed' });
            expect(yield* t.db.value(Schema.Number, { text: "SELECT count(*)::int FROM orders WHERE id=$1", params: [stool.id] })).toBe(0);
            expect(yield* t.db.value(Schema.String, { text: 'SELECT name FROM tags', params: [] })).toBe('stool gone');
        }))
    );

	it.effect('is admitted by the root grant: the writer needs no grant on what is carried', () =>
		Effect.gen(function* () {
			const { run, names } = yield* setup;
			carry = () => ({ on_approved: { tags: { create: [{ name: 'carried' }] } } });
			committed(
				yield* run({
					verb: 'create',
					input: [{ title: 'bench' }],
					authority: authority({ orders: grants('orders') })
				})
			);
			expect(yield* names).toEqual(['CARRIED']);
		})
	);

	it.effect('names an unknown model or a malformed carry as a callback fault', () =>
		Effect.gen(function* () {
			const { run } = yield* setup;
			carry = () => ({ with: { ghosts: { create: [{}] } } });
			const unknown = yield* Effect.flip(run({ verb: 'create', input: [{ title: 'cart' }] }));
			expect(String(unknown)).toMatch(/ghosts: no such model/);
			carry = () => ({ with: { tags: { insert: [] } } });
			const shape = yield* Effect.flip(run({ verb: 'create', input: [{ title: 'cart' }] }));
			expect(String(shape)).toMatch(/with\.tags holds create and update lists/);
		})
	);
});
