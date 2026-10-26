// The value codec on PGlite: periods written on every path (act, nested relation action, seed restore), and the
// update callback's `before` handed over in wire form (X-11, rule 70, §5.8).
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { CrossAnswer, Invocation, Outcome } from '../src/engine/contracts.ts';
import { LIMITS } from '../src/engine/contracts.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { fromStore } from '../src/protocol/errors.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Guest, type Bridge, type GuestShape } from '../src/engine/services.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { restoreSource, seed } from '../src/engine/write/seed.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { read } from '../src/protocol/reads.ts';
import { where } from '@norbital-ai/store';
import { evaluate } from '../src/engine/query/eval.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { TestWorkspace } from '../src/test/effect.ts';
import { program } from './support/guest-fixture.ts';
import { admin, manifest as base, NOW, TODAY } from './write-fixture.ts';

const cols = ['name', 'span', 'slot'];
const manifest: EngineManifest = {
	...base,
	models: {
		shifts: {
			description: 'A shift',
			label: 'name',
			fields: {
				name: { kind: 'text' },
				span: { kind: 'period', of: 'date' },
				slot: { kind: 'period', of: 'instant', optional: true },
				notes: { kind: 'json', optional: true }
			}
		},
		breaks: {
			description: 'A break',
			label: 'name',
			fields: { name: { kind: 'text' }, span: { kind: 'period', of: 'date' } }
		}
	},
	relationships: { 'breaks.shift': { to: 'shifts', inverse: 'breaks', owned: true } },
	collections: {
		shifts: {
			read: { fields: 'all' },
			create: {
				input: { columns: cols, with: { breaks: { create: { columns: ['name', 'span'] } } } }
			},
			update: { input: { columns: cols } }
		},
		breaks: { read: { fields: 'all' } }
	}
};

const StoredShift = Schema.Struct({
	name: Schema.String,
	span: Schema.String,
	slot: Schema.NullOr(Schema.String)
});
const NamePage = Schema.Struct({
	rows: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
	next: Schema.NullOr(Schema.String)
});
const committed = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const idOf = (o: Outcome) => {
	const record = committed(o).records.find((r) => r.collection === 'shifts');
	if (record === undefined) throw new Error('No created shift');
	return record.id;
};
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	yield* applyPlan(db, yield* plan(null, manifest), { accept: true });
	let n = 0;
	const run = (
		over: Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>,
		engine: Partial<WriteEngine> = {}
	) =>
		act(
			{ manifest, db, ...engine },
			{
				collection: 'shifts',
				mode: { _tag: 'Direct' },
				key: `key-${n}`,
				issuedAt: NOW,
				authority: admin,
				bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} },
				invocationId: `inv-${n++}`,
				...over
			}
		);
	const stored = () =>
		db.rows(StoredShift, {
			text: 'select name, span::text, slot::text from shifts order by name',
			params: []
		});
	return { db, run, stored };
});
class CodecFixture extends Context.Service<CodecFixture, Effect.Success<typeof fixture>>()(
	'test/CodecFixture'
) {}
const CodecFixtureLive = Layer.effect(CodecFixture, fixture).pipe(Layer.provide(PgliteDb.layer()));

describe('codec: periods reach Postgres as ranges on every write path (X-11)', () => {
	it.effect(
		'act create, a nested relation create and an update store inclusive date and closed-open instant ranges',
		() =>
			Effect.gen(function* () {
				const { db, run, stored } = yield* CodecFixture;
				const o = committed(
					(yield* run({
						verb: 'create',
						input: {
							name: 'a',
							span: { from: '2026-01-01', to: '2026-01-31' },
							slot: { start: '2026-01-01T09:00:00Z', end: null },
							breaks: { create: [{ name: 'b', span: { from: '2026-01-05', to: null } }] }
						}
					})).outcome
				);
				expect(yield* stored()).toEqual([
					{ name: 'a', span: '[2026-01-01,2026-02-01)', slot: '["2026-01-01 09:00:00+00",)' }
				]);
				expect(
					yield* db.rows(Schema.Struct({ span: Schema.String }), {
						text: 'select span::text from breaks',
						params: []
					})
				).toEqual([{ span: '[2026-01-05,)' }]);
				const id = idOf(o);
				committed(
					(yield* run({
						verb: 'update',
						input: { target: id, set: { span: { from: '2026-02-01', to: '2026-02-01' } } }
					})).outcome
				);
				const [row] = yield* stored();
				if (row === undefined) throw new Error('The updated shift is missing');
				expect(row.span).toBe('[2026-02-01,2026-02-02)');
			}).pipe(Effect.provide(CodecFixtureLive))
	);

	it.effect('an inverted period is refused at decode, before any write', () =>
		Effect.gen(function* () {
			const { run } = yield* CodecFixture;
			expect(
				(yield* run({
					verb: 'create',
					input: { name: 'x', span: { from: '2026-02-01', to: '2026-01-01' } }
				})).outcome
			).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'span' });
		}).pipe(Effect.provide(CodecFixtureLive))
	);

	it.effect('a seed restore stores period values', () =>
		Effect.gen(function* () {
			const { db, stored } = yield* CodecFixture;
			yield* seed(
				manifest,
				db,
				restoreSource({
					shifts: [
						{
							id: '0199a000-0000-7000-8000-000000000001',
							name: 's',
							span: { from: '2025-01-01', to: null }
						}
					]
				}),
				NOW
			);
			expect(yield* stored()).toEqual([{ name: 's', span: '[2025-01-01,)', slot: null }]);
		}).pipe(Effect.provide(CodecFixtureLive))
	);
});

describe('codec: the update callback reads `before` in wire form (§5.8)', () => {
	it.effect(
		'an update hands the guest the stored row as `db.query` would: ISO ends, not range text',
		() =>
			Effect.gen(function* () {
				const { run } = yield* CodecFixture;
				const id = idOf(
					(yield* run({
						verb: 'create',
						input: { name: 'a', span: { from: '2026-01-01', to: '2026-01-31' } }
					})).outcome
				);
				let seen: Json = null;
				const guest: GuestShape = {
					invokeProgram: () =>
						Effect.die(new Error('This fixture does not execute supplied guest programs.')),
					invoke: (inv: Invocation) =>
						Effect.sync(() => {
							expect(inv.kind).toBe('update');
							const changes = Schema.decodeUnknownSync(
								Schema.Array(
									Schema.Struct({
										before: Schema.Json,
										set: Schema.Json
									})
								)
							)(inv.input);
							const change = changes[0];
							if (change === undefined) throw new Error('No update callback input');
							seen = change.before;
							return { kind: 'ok', output: [change.set] };
						})
				};
				committed(
					(yield* run(
						{ verb: 'update', input: { target: id, set: { name: 'b' } } },
						{
							guest,
							manifest: {
								...manifest,
								collections: {
									...manifest.collections,
									shifts: {
										read: { fields: 'all' },
										update: { input: { columns: cols }, transform: true }
									}
								}
							}
						}
					)).outcome
				);
				expect(seen).toMatchObject({
					id,
					name: 'a',
					span: { from: '2026-01-01', to: '2026-01-31' },
					slot: null
				});
			}).pipe(Effect.provide(CodecFixtureLive))
	);
});

describe('codec: `Where` says a json list is empty', () => {
	it.effect(
		'`isEmpty` matches `[]` and null, `isEmpty: false` a non-empty list; SQL and the JS evaluator agree',
		() =>
			Effect.gen(function* () {
				const { db } = yield* CodecFixture;
				const id = (n: number) => `0199a000-0000-7000-8000-00000000000${n}`;
				const span = { from: '2026-01-01', to: null };
				yield* seed(
					manifest,
					db,
					restoreSource({
						shifts: [
							{ id: id(1), name: 'empty', span, notes: [] },
							{ id: id(2), name: 'none', span },
							{ id: id(3), name: 'full', span, notes: ['x'] },
							{ id: id(4), name: 'object', span, notes: { a: 1 } }
						]
					}),
					NOW
				);
				const cat = catalogOf(manifest),
					b = { now: NOW, today: TODAY, tz: 'UTC', params: {} };
				const names = Effect.fnUntraced(function* (isEmpty: boolean) {
					const [answer] = yield* readEngine({ db, manifest }).run(
						[
							read(cat, 'shifts', {
								where: { notes: { isEmpty } },
								select: { name: true },
								orderBy: 'name',
								all: true
							})
						],
						{ as: 'workspace' },
						b
					);
					const page = yield* Schema.decodeUnknownEffect(NamePage)(answer);
					return page.rows.map((r) => r.name);
				});
				expect(yield* names(true)).toEqual(['empty', 'none']);
				expect(yield* names(false)).toEqual(['full']);
				const p = yield* where(cat, 'shifts', { notes: { isEmpty: true } }).pipe(
					Effect.mapError(fromStore)
				);
				expect(
					[[], null, ['x'], { a: 1 }].map((notes) =>
						evaluate({ cat, bindings: b, authority: null }, 'shifts', p, { id: id(9), notes })
					)
				).toEqual([true, true, false, false]);
			}).pipe(Effect.provide(CodecFixtureLive))
	);
});

describe('codec: the MY-nihon payroll read pattern fits one declared query (rule 72)', () => {
	it.live(
		'two waves, 7.1 MB of statutory rules paged 4 rows a crossing with `select`: under 40 crossings, 4 MiB each, 32 MiB read',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					// the hr-payroll MY-nihon lineage's 39 schemes: KiB of `rules` per row, as the seed bank measures them
					const sizes = [
						{ k: 717, n: 5 },
						{ k: 377, n: 5 },
						{ k: 191, n: 4 },
						{ k: 189, n: 1 },
						{ k: 47, n: 5 },
						{ k: 28, n: 5 },
						{ k: 11, n: 2 },
						{ k: 10, n: 2 },
						{ k: 2, n: 5 },
						{ k: 1, n: 5 }
					].flatMap(({ k, n }) => Array<number>(n).fill(k * 1024));
					const m: EngineManifest = {
						...base,
						models: {
							schemes: {
								description: 'A scheme',
								label: 'code',
								fields: {
									code: { kind: 'text' },
									rules: { kind: 'json' },
									authority: { kind: 'json' },
									rate: { kind: 'decimal', scale: 2 }
								}
							},
							people: {
								description: 'A person',
								label: 'name',
								fields: { name: { kind: 'text' }, since: { kind: 'date' } }
							}
						},
						relationships: {},
						collections: {
							schemes: { read: { fields: 'all' } },
							people: { read: { fields: 'all' } }
						}
					};
					// world.ts: wave 1 (9 reads by company), wave 2 (16 reads by people, plus the lineage's schemes 4 rows a page)
					const source = `import { Effect } from 'effect';
import { Decimal } from '@norbital-ai/std/decimal';
export default { collection: { schemes: { bodies: { queries: { payroll: function* (input, ctx) {
	const small = (n) => Effect.all(Array.from({ length: n }, () => ctx.query('people', { where: { name: { like: 'p%' } }, all: true })), { concurrency: 'unbounded' });
	yield* small(9);
	const pages = () => Effect.gen(function* () { const rows = []; let after = null;
		do { const p = yield* ctx.query('schemes', { select: { code: true, rules: true, rate: true }, orderBy: 'code', limit: 4, ...(after === null ? {} : { after }) }); rows.push(...p.rows); after = p.next; } while (after !== null);
		return rows; });
	const [schemes, people] = yield* Effect.all([pages(), small(16)], { concurrency: 'unbounded' });
	const bytes = schemes.reduce((n, s) => n + s.rules[0].when.length, 0);
	return [{ schemes: schemes.length, people: people[0].rows.length, bytes, authority: schemes.some((s) => 'authority' in s), since: typeof people[0].rows[0].since, rate: schemes[0].rate instanceof Decimal, rateText: schemes[0].rate.toString() }];
} } } } } };`;
					const context = yield* Layer.build(
						TestWorkspace.layer({ manifest: m, guest: yield* program(source), now: NOW })
					);
					const db = Context.get(context, TestWorkspace).db;
					const uuid = (i: number) => `0199a000-0000-7000-8000-${String(i).padStart(12, '0')}`;
					yield* seed(
						m,
						db,
						restoreSource({
							schemes: sizes.map((bytes, i) => ({
								id: uuid(i),
								code: `S${String(i).padStart(2, '0')}`,
								rules: [{ when: 'x'.repeat(bytes - 20) }],
								authority: { text: 'y'.repeat(2_200) },
								rate: '11.00'
							})),
							people: Array.from({ length: 89 }, (_, i) => ({
								id: uuid(100 + i),
								name: `p${i}`,
								since: '2024-01-01'
							}))
						}),
						NOW
					);
					const reads = readEngine({ db, manifest: m }),
						batches: number[] = [];
					const bridge: Bridge = {
						cross: (calls) =>
							Effect.gen(function* () {
								batches.push(calls.length);
								const batch = calls.map((call) => {
									if (call._tag !== 'read')
										throw new Error(`Unexpected payroll crossing ${call._tag}`);
									return call.read;
								});
								return (yield* reads.run(
									batch,
									{ as: 'workspace' },
									{ now: NOW, today: TODAY, tz: 'UTC', params: {} }
								)).map((value) => ({ ok: true, value }) satisfies CrossAnswer);
							}).pipe(Effect.orDie)
					};
					const inv: Invocation = {
						id: 'payroll',
						kind: 'query',
						target: 'schemes.payroll',
						input: {},
						ctx: {
							actor: admin.actor,
							now: NOW,
							today: TODAY,
							tz: 'UTC',
							seed: 's'
						},
						budget: {
							crossings: LIMITS.crossings.sync,
							readBytes: LIMITS.readBytes
						}
					};
					const o = yield* Context.get(context, Guest).invoke(inv, bridge);
					if (o.kind !== 'ok') throw new Error(JSON.stringify(o));
					expect(o.output).toEqual([
						{
							schemes: 39,
							people: 89,
							bytes: sizes.reduce((a, b) => a + b - 20, 0),
							authority: false,
							since: 'string',
							rate: true,
							rateText: '11.00'
						}
					]);
					expect(batches.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(LIMITS.crossings.sync);
				})
			)
	);
});
