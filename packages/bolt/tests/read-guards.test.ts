import { describe, expect, it } from '@effect/vitest';
import { Effect, Option, Schema } from 'effect';
import { LIMITS, type Rows, type Sql } from '../src/engine/contracts.ts';
import {
	SqlReadCapture,
	TenantDb,
	type RawDb,
	type SqlReadCaptureService
} from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { Snapshot, StoredSnapshot } from '../src/engine/approvals/snapshot.ts';
import { isComposable } from '../src/engine/query/reader.ts';
import { digestOf, makeReadGuards } from '../src/engine/write/sql.ts';
import { BoltError } from '../src/protocol/errors.ts';

const statement = (value: number): Sql => ({ text: 'SELECT $1::int AS value', params: [value] });
const answer =
	(digest: string): RawDb['read'] =>
	(statements) =>
		Effect.succeed(
			statements.map(() => ({
				rows: [
					{ fp: false, r: { value: 7 } },
					{ fp: true, r: digest }
				],
				affected: 2
			}))
		);
const finish = (crossing: { readonly finish: () => void }) =>
	Effect.try({
		try: crossing.finish,
		catch: (error) =>
			error instanceof BoltError ? error : BoltError.make('internal', 'commit', String(error))
	});

describe('native read guards', () => {
	it.effect(
		'retains the first canonical SQL and parameters only after the whole crossing succeeds',
		() =>
			Effect.gen(function* () {
				const recorder = makeReadGuards('source-1');
				const first = recorder.begin(new Set(['orders']));
				const sql = { text: 'SELECT $1::jsonb AS value', params: [{ a: 1, b: 2 }] };
				const execute: RawDb['read'] = (statements) => {
					expect(statements).toHaveLength(1);
					expect(statements.every(isComposable)).toBe(true);
					expect(statements[0]?.text).toContain(`FROM (${sql.text}) x`);
					expect(statements[0]?.text).toContain(digestOf(sql.text));
					expect(statements[0]?.params).toEqual(sql.params);
					return answer('first')(statements);
				};
				expect(yield* first.capture.read([sql], execute)).toEqual([
					{ rows: [{ value: 7 }], affected: 1 }
				]);
				expect(recorder.snapshot().guards.fingerprints).toEqual([]);
				yield* finish(first);
				const reread = recorder.begin(new Set(['orders', 'sys_user']));
				yield* reread.capture.read([{ text: sql.text, params: [{ b: 2, a: 1 }] }], answer('first'));
				yield* finish(reread);
				const beforeFailure = recorder.snapshot();
				expect(beforeFailure.guards).toEqual({
					sourceEpoch: 'source-1',
					fingerprints: [{ sql, digest: 'first' }],
					tables: ['orders', 'sys_user']
				});
				expect(JSON.stringify(beforeFailure.guards.fingerprints[0]?.sql.params)).toBe(
					JSON.stringify(sql.params)
				);
				const failed = recorder.begin(new Set(['customers']));
				const error = yield* Effect.flip(
					Effect.gen(function* () {
						yield* failed.capture.read([statement(99)], answer('unpublished'));
						return yield* Effect.fail(BoltError.make('badAnswer', 'decode', 'crossing refused'));
					})
				);
				expect(error).toBeInstanceOf(BoltError);
				if (!(error instanceof BoltError)) throw error;
				expect(error.code).toBe('badAnswer');
				expect(recorder.snapshot()).toEqual(beforeFailure);
				const failedRead = recorder.begin(new Set(['customers']));
				expect(
					yield* Effect.flip(
						failedRead.capture.read([statement(100)], () =>
							Effect.fail(DbError.make('08006', 'connection lost'))
						)
					)
				).toMatchObject({ sqlstate: '08006' });
				expect(recorder.snapshot()).toEqual(beforeFailure);
			})
	);

	it.effect(
		'poisons a nonrepeatable read until a fresh attempt even when the original value returns',
		() =>
			Effect.gen(function* () {
				const recorder = makeReadGuards('source-1');
				const first = recorder.begin(new Set(['orders']));
				yield* first.capture.read([statement(1)], answer('first'));
				yield* finish(first);
				const acting = recorder.snapshot();
				const changed = recorder.begin(new Set(['orders', 'customers']));
				yield* changed.capture.read([statement(1)], answer('changed'));
				expect(yield* Effect.flip(finish(changed))).toMatchObject({ code: 'conflict' });
				const poisoned = recorder.snapshot();
				expect(poisoned.generation).toBeGreaterThan(acting.generation);
				expect(poisoned.guards).toEqual({ ...acting.guards, inconsistent: true });
				recorder.consume(acting.generation);
				expect(recorder.snapshot().guards.inconsistent).toBe(true);
				const restored = recorder.begin(new Set(['orders']));
				yield* restored.capture.read([statement(1)], answer('first'));
				expect(yield* Effect.flip(finish(restored))).toMatchObject({ code: 'conflict' });
				expect(recorder.snapshot().guards.inconsistent).toBe(true);
				const fresh = makeReadGuards('source-1');
				const retry = fresh.begin(new Set(['orders']));
				yield* retry.capture.read([statement(1)], answer('first'));
				yield* finish(retry);
				expect(fresh.snapshot().guards.inconsistent).toBeUndefined();
			})
	);

	it.effect(
		'detects changed and restored reads within one crossing without publishing any of it',
		() =>
			Effect.gen(function* () {
				const recorder = makeReadGuards('source-1');
				const crossing = recorder.begin(new Set(['orders']));
				yield* crossing.capture.read([statement(1)], answer('first'));
				yield* crossing.capture.read([statement(1)], answer('changed'));
				yield* crossing.capture.read([statement(1)], answer('first'));
				expect(yield* Effect.flip(finish(crossing))).toMatchObject({ code: 'conflict' });
				expect(recorder.snapshot().guards).toEqual({
					sourceEpoch: 'source-1',
					fingerprints: [],
					tables: [],
					inconsistent: true
				});
			})
	);

	it.effect(
		'retains the SQL and nested parameters that executed when the caller later mutates its input',
		() =>
			Effect.gen(function* () {
				const recorder = makeReadGuards('source-1');
				const nested = { status: { value: 'draft' } };
				const sql = { text: 'SELECT $1::jsonb AS value', params: [nested] };
				const crossing = recorder.begin(new Set(['orders']));
				yield* crossing.capture.read([sql], answer('original'));
				sql.text = 'SELECT false AS changed';
				nested.status.value = 'review';
				sql.params.push({ status: { value: 'extra' } });
				yield* finish(crossing);
				const expected = {
					sql: { text: 'SELECT $1::jsonb AS value', params: [{ status: { value: 'draft' } }] },
					digest: 'original'
				};
				expect(recorder.snapshot().guards.fingerprints).toEqual([expected]);
				nested.status.value = 'done';
				sql.params.length = 0;
				expect(recorder.snapshot().guards.fingerprints).toEqual([expected]);
			})
	);

	it.effect(
		'consumes an act snapshot without erasing newer rereads or an in-flight crossing publication',
		() =>
			Effect.gen(function* () {
				const recorder = makeReadGuards('source-1');
				const first = recorder.begin(new Set(['orders']));
				yield* first.capture.read([statement(1), statement(2)], answer('old'));
				yield* finish(first);
				const acting = recorder.snapshot();
				const inFlight = recorder.begin(new Set(['customers']));
				yield* inFlight.capture.read([statement(3)], answer('concurrent'));
				const reread = recorder.begin(new Set(['orders', 'sys_user']));
				yield* reread.capture.read([statement(1)], answer('old'));
				yield* finish(reread);
				recorder.consume(acting.generation);
				expect(recorder.snapshot().guards.fingerprints).toEqual([
					{ sql: statement(1), digest: 'old' }
				]);
				expect(recorder.snapshot().guards.tables).toEqual(['orders', 'sys_user']);
				yield* finish(inFlight);
				const remaining = recorder.snapshot();
				expect(remaining.generation).toBeGreaterThan(acting.generation);
				expect(remaining.guards.fingerprints).toEqual([
					{ sql: statement(1), digest: 'old' },
					{ sql: statement(3), digest: 'concurrent' }
				]);
				expect(remaining.guards.tables).toEqual(['customers', 'orders', 'sys_user']);
				recorder.consume(remaining.generation);
				expect(recorder.snapshot().guards).toEqual({
					sourceEpoch: 'source-1',
					fingerprints: [],
					tables: []
				});
			})
	);

	it.effect(
		'counts coalesced statements and refuses an overflow without publishing part of the crossing',
		() =>
			Effect.gen(function* () {
				const recorder = makeReadGuards('source-1');
				const repeated = recorder.begin(new Set(['orders']));
				yield* repeated.capture.read(
					Array.from({ length: LIMITS.readGuards.count + 1 }, () => statement(0)),
					answer('repeated')
				);
				yield* finish(repeated);
				expect(recorder.snapshot().guards.fingerprints).toHaveLength(1);
				const before = recorder.snapshot();
				const overflow = recorder.begin(new Set(['customers']));
				yield* overflow.capture.read(
					Array.from({ length: LIMITS.readGuards.count }, (_, i) => statement(i + 1)),
					answer('overflow')
				);
				expect(yield* Effect.flip(finish(overflow))).toMatchObject({ code: 'readBudgetExceeded' });
				expect(recorder.snapshot()).toEqual(before);
			})
	);

	it.effect(
		'budgets coalesced SQL and UTF-8 parameter bytes without partially replacing earlier reads',
		() =>
			Effect.gen(function* () {
				const recorder = makeReadGuards('source-1');
				const sql = {
					text: 'SELECT $1::text AS value',
					params: ['é'.repeat(LIMITS.readGuards.bytes / 4)]
				};
				const repeated = recorder.begin(new Set(['orders']));
				yield* repeated.capture.read([sql, sql, sql], answer('coalesced'));
				yield* finish(repeated);
				expect(recorder.snapshot().guards.fingerprints).toHaveLength(1);
				const before = recorder.snapshot();
				const overflow = recorder.begin(new Set(['customers']));
				yield* overflow.capture.read(
					[{ text: sql.text, params: ['界'.repeat(Math.floor(LIMITS.readGuards.bytes / 3))] }],
					answer('overflow')
				);
				expect(yield* Effect.flip(finish(overflow))).toMatchObject({ code: 'readBudgetExceeded' });
				expect(recorder.snapshot()).toEqual(before);
			})
	);

	it.effect(
		'captures only the provided read context, including typed reads, once through nested adapters',
		() =>
			Effect.gen(function* () {
				let reads = 0;
				let writes = 0;
				let transactions = 0;
				let captures = 0;
				const result: Rows = { rows: [{ value: 7 }], affected: 1 };
				const raw: RawDb = {
					session: () =>
						Effect.fail(DbError.make('0A000', 'This SQL capture fixture has no native session.')),
					read: (statements) =>
						Effect.sync(() => {
							reads++;
							return statements.map(() => result);
						}),
					write: () =>
						Effect.sync(() => {
							writes++;
							return result;
						}),
					transaction: (batch) =>
						Effect.sync(() => {
							transactions++;
							return batch.statements.map(() => result);
						})
				};
				const db = TenantDb.typed(TenantDb.typed(raw));
				const capture: SqlReadCaptureService = {
					read: Effect.fn('test.captureNativeRead')(function* (
						statements: readonly Sql[],
						execute: RawDb['read']
					) {
						captures++;
						expect(yield* SqlReadCapture).toBeUndefined();
						return yield* execute(statements);
					})
				};
				const Row = Schema.Struct({ value: Schema.Number });
				const sql = statement(7);
				yield* db.read([sql]);
				expect(captures).toBe(0);
				yield* Effect.gen(function* () {
					expect(yield* db.read([sql])).toEqual([result]);
					expect(yield* db.rows(Row, sql)).toEqual([{ value: 7 }]);
					expect(yield* db.one(Row, sql)).toEqual(Option.some({ value: 7 }));
					expect(yield* db.value(Schema.Number, sql)).toBe(7);
					expect(yield* db.returning(Row, sql)).toEqual([{ value: 7 }]);
					yield* db.transaction({ statements: [sql] });
				}).pipe(Effect.provideService(SqlReadCapture, capture));
				expect({ captures, reads, writes, transactions }).toEqual({
					captures: 4,
					reads: 5,
					writes: 1,
					transactions: 1
				});
				yield* db.read([sql]);
				expect({ captures, reads }).toEqual({ captures: 4, reads: 6 });
			})
	);

	it('keeps native SQL guard metadata out of an authored public approval flow', () => {
		const flow = {
			kind: 'steps',
			steps: [{ name: 'Review', teams: ['finance'], users: [] }],
			superseded_by: []
		};
		const forged = {
			...flow,
			__boltReadGuards: {
				sourceEpoch: 'forged-source',
				tables: ['orders'],
				fingerprints: [{ sql: { text: 'SELECT pg_sleep($1)', params: [99] }, digest: 'forged' }]
			}
		};
		expect(Schema.decodeUnknownSync(Snapshot)(forged)).toEqual(flow);
		expect(() =>
			Schema.decodeUnknownSync(Snapshot, { onExcessProperty: 'error' })(forged)
		).toThrow();
		expect(Schema.decodeUnknownSync(StoredSnapshot)(forged)).toEqual(forged);
	});
});
