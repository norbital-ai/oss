// The value codec on PGlite: periods written on every path (act, nested relation action, seed restore), and the
// update callback's `before` handed over in wire form (X-11, rule 70, §5.8).
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Invocation, Outcome } from '../src/engine/contracts.ts';
import { TestDb } from '../src/test/database.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { type GuestShape } from '../src/engine/services.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { restoreSource, seed } from '../src/engine/write/seed.ts';
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
				slot: { kind: 'period', of: 'instant', optional: true }
			}
		},
		breaks: {
			description: 'A break',
			label: 'name',
			fields: { name: { kind: 'text' }, span: { kind: 'period', of: 'date' } }
		}
	},
	relationships: { 'breaks.shift': { to: 'shifts', inverse: 'breaks', owned: true } },
	exposures: {
		shifts: {
			read: { shifts: { fields: 'all' } },
			create: { columns: { shifts: cols, 'shifts.breaks': ['name', 'span'] } },
			update: { columns: { shifts: cols } }
		},
		breaks: { read: { breaks: { fields: 'all' } } }
	}
};

const StoredShift = Schema.Struct({
	name: Schema.String,
	span: Schema.String,
	slot: Schema.NullOr(Schema.String)
});
const committed = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const idOf = (o: Outcome) => {
	const record = committed(o).records.find((r) => r.model === 'shifts');
	if (record === undefined) throw new Error('No created shift');
	return record.id;
};
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	let n = 0;
	const run = (
		over: Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>,
		engine: Partial<WriteEngine> = {}
	) =>
		act(
			{ manifest, db, ...engine },
			{
				model: 'shifts',
				mode: { _tag: 'Direct' },
				key: `key-${n}`,
				issuedAt: NOW,
				authority: admin,
				bindings: { now: NOW, today: TODAY, tz: 'UTC' },
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
const CodecFixtureLive = Layer.effect(CodecFixture, fixture).pipe(Layer.provide(TestDb.layer(manifest)));

describe('codec: periods reach Postgres as ranges on every write path (X-11)', () => {
	it.effect(
		'act create, a nested relation create and an update store inclusive date and closed-open instant ranges',
		() =>
			Effect.gen(function* () {
				const { db, run, stored } = yield* CodecFixture;
				const o = committed(
					(yield* run({
						verb: 'create',
						input: [
							{
								name: 'a',
								span: { from: '2026-01-01', to: '2026-01-31' },
								slot: { start: '2026-01-01T09:00:00Z', end: null },
								breaks: [{ name: 'b', span: { from: '2026-01-05', to: null } }]
							}
						]
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
						input: [{ target: id, set: { span: { from: '2026-02-01', to: '2026-02-01' } } }]
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
					input: [{ name: 'x', span: { from: '2026-02-01', to: '2026-01-01' } }]
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
						input: [{ name: 'a', span: { from: '2026-01-01', to: '2026-01-31' } }]
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
						{ verb: 'update', input: [{ target: id, set: { name: 'b' } }] },
						{
							guest,
							manifest: {
								...manifest,
								exposures: {
									...manifest.exposures,
									shifts: {
										read: { shifts: { fields: 'all' } },
										update: { columns: { shifts: cols }, transform: true }
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

