// The tenant database (C11, per activation; W2.E1): complete, bounded SQL work, failing with the
// driver's `DbError` (the SQLSTATE the write compiler maps to a refusal, rule 20) and, for a typed read, `BoltError`
// naming the table of a row that does not decode. Completed batches release their connection before answering;
// interactive automation transactions own a native, absolutely bounded lease. Adapters: `postgres.ts`, `pglite.ts`.
import { Context, Effect, type Option, type Schema, type Scope } from 'effect';
import type { Lock, Rows, Sql } from '../contracts.ts';
import type { DbError } from '../errors.ts';
import type { BoltError } from '../../protocol/errors.ts';
import { decodeOne, decodeRows, decodeValue } from './rows.ts';
import { AuditMutation, auditedBatch } from '../audit-context.ts';

/** Complete database work, prepared before a connection is acquired; no application callback runs inside it. */
export type DbBatch = {
	readonly statements: readonly Sql[];
	readonly lock?: Lock;
	/** Native dry-run: execute and answer the statements, then roll back all of their effects. */
	readonly rollback?: true;
};

/** One native SERIALIZABLE lease. Its fixed five-second deadline starts at admission and never resets. */
export type DbSession = {
	readonly db: Omit<RawDb, 'session'>;
	readonly commit: Effect.Effect<void, DbError>;
	readonly rollback: Effect.Effect<void, DbError>;
};

/** What an adapter implements; `TenantDb.typed` adds the decoding reads over it. */
export type RawDb = {
	/** Read statements share one snapshot and answer in order; rows are relayed as JSON (D5). */
	readonly read: (statements: readonly Sql[]) => Effect.Effect<readonly Rows[], DbError>;
	/** An act's one write statement, with fixed deadlines and native locks before execution. */
	readonly write: (statement: Sql, lock?: Lock) => Effect.Effect<Rows, DbError>;
	/** Complete SQL statements atomically; answers are decoded only after commit or native dry-run rollback. */
	readonly transaction: (batch: DbBatch) => Effect.Effect<readonly Rows[], DbError>;
	/** PG17+ only: the driver enforces the deadline independently of the guest; unsupported hosts fail before BEGIN. */
	readonly session: () => Effect.Effect<DbSession, DbError, Scope.Scope>;
};
export type SqlReadCaptureService = {
	readonly read: (
		statements: readonly Sql[],
		execute: RawDb['read']
	) => Effect.Effect<readonly Rows[], DbError>;
};
/** Native transaction routing. Captured services retain their contracts while every SQL call uses this lease. */
export const SqlSessionDb = Context.Reference<Omit<RawDb, 'session'> | undefined>(
	'bolt/SqlSessionDb',
	{ defaultValue: () => undefined }
);
export const SqlReadCapture = Context.Reference<SqlReadCaptureService | undefined>(
	'bolt/SqlReadCapture',
	{ defaultValue: () => undefined }
);
export type TenantDbShape = RawDb & {
	/** One read's rows, each decoded by `schema`. */
	readonly rows: <A>(
		schema: Schema.Decoder<A>,
		statement: Sql
	) => Effect.Effect<readonly A[], DbError | BoltError>;
	/** The row of a read that answers at most one. */
	readonly one: <A>(
		schema: Schema.Decoder<A>,
		statement: Sql
	) => Effect.Effect<Option.Option<A>, DbError | BoltError>;
	/** The one column of the one row a read answers. */
	readonly value: <A>(
		schema: Schema.Decoder<A>,
		statement: Sql
	) => Effect.Effect<A, DbError | BoltError>;
	/** A write's `RETURNING` rows, each decoded by `schema`. */
	readonly returning: <A>(
		schema: Schema.Decoder<A>,
		statement: Sql,
		lock?: Lock
	) => Effect.Effect<readonly A[], DbError | BoltError>;
};

const NONE: Rows = { rows: [], affected: 0 };
export class TenantDb extends Context.Service<TenantDb, TenantDbShape>()('bolt/TenantDb') {
	/** An adapter's calls with the decoding reads over them. */
	static readonly typed = (raw: RawDb): TenantDbShape => {
		const read = Effect.fn('Bolt.tenantRead')(function* (statements: readonly Sql[]) {
			const session = yield* SqlSessionDb;
			if (session !== undefined) return yield* session.read(statements);
			const capture = yield* SqlReadCapture;
			if (capture === undefined) return yield* raw.read(statements);
			return yield* capture
				.read(statements, raw.read)
				.pipe(Effect.provideService(SqlReadCapture, undefined));
		});
		const write: RawDb['write'] = Effect.fn('Bolt.tenantWrite')(function* (statement, lock) {
			const session = yield* SqlSessionDb;
			if (session !== undefined) return yield* session.write(statement, lock);
			const audit = yield* AuditMutation;
			if (audit === undefined) return yield* raw.write(statement, lock);
			const rows = yield* raw
				.transaction(
					auditedBatch({ statements: [statement], ...(lock === undefined ? {} : { lock }) }, audit)
				)
				.pipe(Effect.provideService(AuditMutation, undefined));
			return rows[1] ?? NONE;
		});
		const transaction: RawDb['transaction'] = Effect.fn('Bolt.tenantBatch')(function* (batch) {
			const session = yield* SqlSessionDb;
			if (session !== undefined) return yield* session.transaction(batch);
			const audit = yield* AuditMutation;
			if (audit === undefined) return yield* raw.transaction(batch);
			const answers = yield* raw
				.transaction(auditedBatch(batch, audit))
				.pipe(Effect.provideService(AuditMutation, undefined));
			return answers.slice(1, -1);
		});
		return {
			...raw,
			read,
			write,
			transaction,
			rows: (schema, statement) =>
				Effect.flatMap(read([statement]), ([r]) => decodeRows(schema, r ?? NONE)),
			one: (schema, statement) =>
				Effect.flatMap(read([statement]), ([r]) => decodeOne(schema, r ?? NONE)),
			value: (schema, statement) =>
				Effect.flatMap(read([statement]), ([r]) => decodeValue(schema, r ?? NONE)),
			returning: (schema, statement, lock) =>
				Effect.flatMap(write(statement, lock), (r) => decodeRows(schema, r))
		};
	};
}
