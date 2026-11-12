import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect, Option, Schema } from 'effect';
import { memory_audit } from '../../bolt-cli/src/test/index.ts';
import { Audit, audit_shape } from '../src/engine/audit.ts';
import { AuditMutation } from '../src/engine/audit-context.ts';
import { audited } from '../src/engine/audit-operation.ts';
import type { Rows, Sql } from '../src/engine/contracts.ts';
import { SqlReadCapture, TenantDb, type RawDb } from '../src/engine/db/tenant-db.ts';
import { db_error } from '../src/engine/db/wire.ts';
import { DbError, is_transient } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';

const empty: Rows = { rows: [], affected: 0 };
const statement: Sql = { text: 'SELECT n FROM items', params: [] };
const Row = Schema.Struct({ n: Schema.Number }).annotate({ identifier: 'items' });
const adapter = (answers: readonly Rows[]): RawDb => ({
	read: () => Effect.succeed(answers),
	write: () => Effect.succeed(empty),
	transaction: () => Effect.succeed(answers)
});
const audit: AuditMutation = {
	event: {
		id: 'audit-event', operation_id: 'audit-operation', at: '2026-09-25T10:00:00Z',
		category: 'write', action: 'database.test', status: 'prepared',
		actor: { kind: 'system', id: 'test', label: null }, subject: null,
		invocation: null, transaction: null, run: null, approval: null, payload: {}
	},
	recorded_at: '2026-09-25T10:00:00Z',
	committed: {}
};

describe('native database statement result boundary', () => {
	it.effect('requires exactly one result per read statement, including sparse arrays, while zero statements may return zero', () =>
		Effect.gen(function* () {
			expect(yield* TenantDb.typed(adapter([])).read([])).toEqual([]);
			const sparse: Rows[] = [];
			sparse.length = 1;
			for (const answers of [[], [empty, empty], sparse]) {
				const error = yield* Effect.flip(TenantDb.typed(adapter(answers)).read([statement]));
				expect(error).toMatchObject({ _tag: 'DbError', sqlstate: 'XX000' });
				expect(is_transient(error)).toBe(false);
			}
			expect(yield* Effect.flip(TenantDb.typed(adapter([empty])).read([]))).toMatchObject({ sqlstate: 'XX000' });
		})
	);
	it.effect('does not turn missing typed-read results into empty rows or not-found, and preserves legitimate empty results', () =>
		Effect.gen(function* () {
			const broken = TenantDb.typed(adapter([]));
			const probes: readonly Effect.Effect<unknown, DbError | BoltError>[] = [
				broken.rows(Row, statement), broken.one(Row, statement), broken.value(Schema.Number, statement)
			];
			for (const probe of probes)
				expect(yield* Effect.flip(probe)).toMatchObject({ _tag: 'DbError', sqlstate: 'XX000' });
			const absent = TenantDb.typed(adapter([empty]));
			expect(yield* absent.rows(Row, statement)).toEqual([]);
			expect(yield* absent.one(Row, statement)).toEqual(Option.none());
			expect(yield* Effect.flip(absent.value(Schema.Number, statement))).toMatchObject({ _tag: 'BoltError', code: 'internal' });
			const malformed = TenantDb.typed(adapter([{ rows: [{ n: 'wrong' }], affected: 1 }]));
			expect(yield* Effect.flip(malformed.rows(Row, statement))).toMatchObject({ _tag: 'BoltError', code: 'internal' });
		})
	);
	it.effect('checks a capture result even when its underlying adapter returned every result', () =>
		Effect.gen(function* () {
			let executed = 0;
			const db = TenantDb.typed({
				...adapter([empty]),
				read: () => Effect.sync(() => { executed++; return [empty]; })
			});
			const result = yield* Effect.result(db.one(Row, statement).pipe(Effect.provideService(SqlReadCapture, {
				read: (statements, execute) => execute(statements).pipe(Effect.as([]))
			})));
			expect(result).toMatchObject({ _tag: 'Failure', failure: { sqlstate: 'XX000', message: expect.stringContaining('captured read') } });
			expect(executed).toBe(1);
		})
	);
	it.effect('rejects incomplete transaction answers without claiming rollback or retrying an uncertain write', () =>
		Effect.gen(function* () {
			let calls = 0;
			const db = TenantDb.typed({
				...adapter([]),
				transaction: () => Effect.sync(() => { calls++; return []; })
			});
			const error = yield* Effect.flip(db.transaction({ statements: [{ text: 'UPDATE sys_user SET active = false', params: [] }] }));
			expect(error).toMatchObject({ sqlstate: 'XX000', outcome_unknown: true, message: expect.stringContaining('commit or rollback outcome is unverified') });
			expect(calls).toBe(1);
			expect(db.identityWrites()).toBe(1);
			expect(is_transient(error)).toBe(false);
			expect(yield* TenantDb.typed(adapter([])).transaction({ statements: [] })).toEqual([]);
		})
	);
	it.effect('an audited write requires context, write and receipt results, including an actual middle result', () =>
		Effect.gen(function* () {
			const sparse: Rows[] = [empty];
			sparse.length = 3;
			sparse[2] = empty;
			for (const answers of [[], [empty], [empty, empty], [empty, empty, empty, empty], sparse]) {
				let submitted: readonly Sql[] = [];
				const db = TenantDb.typed({
					...adapter(answers),
					write: () => Effect.die(new Error('An audited write must use its atomic batch.')),
					transaction: (batch) => Effect.sync(() => { submitted = batch.statements; return answers; })
				});
				const write = { text: 'UPDATE sys_user SET active = false RETURNING id', params: [] };
				const error = yield* Effect.flip(db.write(write).pipe(Effect.provideService(AuditMutation, audit)));
				expect(error).toMatchObject({ sqlstate: 'XX000' });
				expect(submitted).toHaveLength(3);
				expect(submitted[1]).toBe(write);
				expect(db.identityWrites()).toBe(1);
			}
			const returned: Rows = { rows: [{ id: 'changed' }], affected: 1 };
			const valid = TenantDb.typed(adapter([empty, returned, empty]));
			expect(yield* valid.write(statement).pipe(Effect.provideService(AuditMutation, audit))).toBe(returned);
		})
	);
	it.effect('an audited batch strips only its two framing results after validating all requested answers', () =>
		Effect.gen(function* () {
			const first: Rows = { rows: [{ n: 1 }], affected: 1 }, second: Rows = { rows: [{ n: 2 }], affected: 1 };
			const batch = { statements: [statement, statement], rollback: true as const };
			expect(yield* TenantDb.typed(adapter([empty, first, second, empty])).transaction(batch).pipe(
				Effect.provideService(AuditMutation, audit)
			)).toEqual([first, second]);
			expect(yield* Effect.flip(TenantDb.typed(adapter([empty, first, empty])).transaction(batch).pipe(
				Effect.provideService(AuditMutation, audit)
			))).toMatchObject({ sqlstate: 'XX000' });
			expect(yield* TenantDb.typed(adapter([empty, empty])).transaction({ statements: [] }).pipe(
				Effect.provideService(AuditMutation, audit)
			)).toEqual([]);
		})
	);
	it.effect('preserves a genuine driver failure instead of replacing it with a cardinality failure', () =>
		Effect.gen(function* () {
			const outage = DbError.make('08006', 'The database is unavailable.');
			const db = TenantDb.typed({
				read: () => Effect.fail(outage), write: () => Effect.fail(outage), transaction: () => Effect.fail(outage)
			});
			expect(yield* Effect.flip(db.rows(Row, statement))).toBe(outage);
			expect(yield* Effect.flip(db.write(statement).pipe(Effect.provideService(AuditMutation, audit)))).toBe(outage);
		})
	);
	it.effect('keeps uncertainty through actual error encoding and foreign-graph reconstruction without making a protocol fault transient', () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(TenantDb.typed(adapter([])).transaction({ statements: [statement] }));
			const encoded = Schema.encodeSync(DbError)(failure);
			expect(encoded).toMatchObject({ sqlstate: 'XX000', outcome_unknown: true });
			const restored = db_error(encoded);
			expect(restored).toMatchObject({ sqlstate: 'XX000', outcome_unknown: true });
			expect(is_transient(restored)).toBe(false);
			for (const marker of [false, 'true', 1, undefined])
				expect(db_error({ sqlstate: 'XX000', message: 'Contract failed.', outcome_unknown: marker }).outcome_unknown).toBeUndefined();
		})
	);
	it.effect('leaves a transaction protocol fault unresolved without a receipt, while genuine receipt proof establishes the commit', () =>
		Effect.gen(function* () {
			for (const proven of [false, true]) {
				const store = memory_audit();
				const service = yield* audit_shape(store.port).pipe(Effect.provide(NodeCrypto.layer));
				const receipt: Rows = { rows: [{
					at: '2026-09-25T10:00:00Z', outcome: null, key_reuse: false,
					acknowledged: false, expired: false, due: false, records: []
				}], affected: 0 };
				const db = TenantDb.typed({
					...adapter([]),
					read: (statements) => Effect.succeed(statements.map(() => proven ? receipt : empty))
				});
				const failure = yield* Effect.flip(audited(db, {
					category: 'write', action: 'database.test', actor: audit.event.actor, payload: {}
				}, db.write(statement)).pipe(Effect.provideService(Audit, service)));
				expect(failure).toMatchObject({ sqlstate: 'XX000', outcome_unknown: true });
				expect([...store.records.values()].map((event) => event.status)).toEqual(['prepared', proven ? 'committed' : 'unknown']);
				expect((yield* service.pending({ limit: 10 })).rows).toHaveLength(proven ? 0 : 1);
			}
		})
	);
});
