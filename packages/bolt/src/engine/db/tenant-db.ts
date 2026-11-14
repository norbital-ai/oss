// The tenant database (C11, per activation; W2.E1): complete, bounded SQL work, failing with the
// driver's `DbError` (the SQLSTATE the write compiler maps to a refusal) and, for a typed read, `BoltError`
// naming the table of a row that does not decode. Batches release their connection before answering.
import { Clock, Context, Effect, Semaphore, type Option, type Schema } from 'effect';
import { DbError, type DbBatch, type Lock, type RawDb, type Rows, type Sql } from '@norbital-ai/host-api';
import type { BoltError } from '../../protocol/errors.ts';
import { decodeOne, decodeRows, decodeValue } from './rows.ts';
import { AuditMutation, auditedBatch } from '../audit-context.ts';

export type SqlReadCaptureService = {
	readonly read: (
		statements: readonly Sql[],
		execute: RawDb['read']
	) => Effect.Effect<readonly Rows[], DbError>;
};
/** Set on the work a generation owes its database, so its own statements do not wait for it. */
const SqlOwed = Context.Reference<boolean>('bolt/SqlOwed', { defaultValue: () => false });
/** A statement that can change who is signed in or what they may do. */
const IDENTITY = /\bsys_(?:user|session)\b/;
/** Neon's default: a database touched this recently is still awake, so one more read costs no wake. */
const AWAKE_MILLIS = 5 * 60_000;
export const SqlReadCapture = Context.Reference<SqlReadCaptureService | undefined>(
	'bolt/SqlReadCapture',
	{ defaultValue: () => undefined }
);
/** One tenant database as the engine uses it: the adapter's raw calls plus deferred setup, wake tracking and decoding reads. */
export type TenantDbShape = RawDb & {
	/**
	 * Work this generation owes its database, run once just before its first statement. A cold start owes it rather
	 * than doing it, so a request or a cron slot that needs no data leaves a database billed by the second asleep.
	 */
	readonly owe: (work: Effect.Effect<void, DbError>) => void;
	/** Settles what is owed, for work that must know its outcome before it composes a statement. */
	readonly ready: Effect.Effect<void, DbError>;
	/** Whether this generation used the database so lately that it is still awake. */
	readonly awake: Effect.Effect<boolean>;
	/**
	 * How many statements on people or sessions have finished: what a memo of either keeps beside its answer, read
	 * before the read, so a write that lands at any point after makes the answer stale at once.
	 */
	readonly identityWrites: () => number;
	/** Work that only checks for work: unless it writes, it does not count as the database being in use. */
	readonly quietly: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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

const protocolFailure = (operation: string, detail: string) => {
	const fields = {
		sqlstate: 'XX000',
		message: `The database ${operation} returned ${detail}.${operation === 'transaction' ? ' Its commit or rollback outcome is unverified.' : ''}`
	};
	return operation === 'transaction' ? DbError.make({ ...fields, outcome_unknown: true }) : DbError.make(fields);
};
const complete = (rows: readonly Rows[], expected: number, operation: string): Effect.Effect<readonly Rows[], DbError> => {
	if (rows.length !== expected)
		return Effect.fail(protocolFailure(operation, `${rows.length} statement results; expected ${expected}`));
	for (let index = 0; index < expected; index++)
		if (rows[index] === undefined)
			return Effect.fail(protocolFailure(operation, `no result for statement ${index + 1}`));
	return Effect.succeed(rows);
};
/** The activation's tenant database service; `TenantDb.typed` wraps a host adapter into its shape. */
export class TenantDb extends Context.Service<TenantDb, TenantDbShape>()('bolt/TenantDb') {
	/** An adapter's calls with the decoding reads over them. */
	static readonly typed = (adapter: RawDb): TenantDbShape => {
		let owed: Effect.Effect<void, DbError> | undefined,
			touched = Number.NEGATIVE_INFINITY,
			writes = 0,
			identity = 0;
		const turn = Semaphore.makeUnsafe(1);
		const pay = Effect.gen(function* () {
			if (owed === undefined || (yield* SqlOwed)) return;
			yield* turn.withPermit(
				Effect.suspend(() =>
					owed === undefined
						? Effect.void
						: owed.pipe(
								Effect.provideService(SqlOwed, true),
								Effect.provideService(SqlReadCapture, undefined),
								Effect.provideService(AuditMutation, undefined),
								Effect.tap(() =>
									Effect.sync(() => {
										owed = undefined;
									})
								)
							)
				)
			);
		});
		const settled = Effect.gen(function* () {
			if (yield* SqlOwed) return;
			touched = yield* Clock.currentTimeMillis;
			yield* pay;
		});
		/** Counted once the statements end, so a read that overlapped them can never be kept as current. */
		const wrote = (texts: readonly string[]) =>
			Effect.sync(() => {
				writes++;
				if (texts.some((text) => IDENTITY.test(text))) identity++;
			});
		const raw: RawDb = {
			read: (statements) => Effect.andThen(settled, adapter.read(statements)).pipe(
				Effect.flatMap((rows) => complete(rows, statements.length, 'read'))
			),
			write: (statement, lock) =>
				Effect.andThen(settled, adapter.write(statement, lock)).pipe(
					Effect.ensuring(wrote([statement.text]))
				),
			transaction: (batch) =>
				Effect.andThen(settled, adapter.transaction(batch)).pipe(
					Effect.flatMap((rows) => complete(rows, batch.statements.length, 'transaction')),
					Effect.ensuring(wrote(batch.statements.map((statement) => statement.text)))
				)
		};
		const read = Effect.fn('Bolt.tenantRead')(function* (statements: readonly Sql[]) {
			const capture = yield* SqlReadCapture;
			if (capture === undefined) return yield* raw.read(statements);
			return yield* capture
				.read(statements, raw.read)
				.pipe(
					Effect.provideService(SqlReadCapture, undefined),
					Effect.flatMap((rows) => complete(rows, statements.length, 'captured read'))
				);
		});
		const read_one = (statement: Sql) => Effect.flatMap(read([statement]), ([row]) =>
			row === undefined
				? Effect.fail(protocolFailure('read', 'no result for its statement'))
				: Effect.succeed(row)
		);
		const write: RawDb['write'] = Effect.fn('Bolt.tenantWrite')(function* (statement, lock) {
			const audit = yield* AuditMutation;
			if (audit === undefined) return yield* raw.write(statement, lock);
			const rows = yield* raw
				.transaction(
					auditedBatch({ statements: [statement], ...(lock === undefined ? {} : { lock }) }, audit)
				)
				.pipe(Effect.provideService(AuditMutation, undefined));
			const answer = rows[1];
			if (answer === undefined)
				return yield* Effect.fail(protocolFailure('transaction', 'no result for the audited write'));
			return answer;
		});
		const transaction: RawDb['transaction'] = Effect.fn('Bolt.tenantBatch')(function* (batch) {
			const audit = yield* AuditMutation;
			if (audit === undefined) return yield* raw.transaction(batch);
			const answers = yield* raw
				.transaction(auditedBatch(batch, audit))
				.pipe(Effect.provideService(AuditMutation, undefined));
			return answers.slice(1, -1);
		});
		return {
			...raw,
			owe: (work) => {
				owed = owed === undefined ? work : Effect.andThen(owed, work);
			},
			ready: pay,
			awake: Effect.map(Clock.currentTimeMillis, (now) => now - touched < AWAKE_MILLIS),
			identityWrites: () => identity,
			quietly: (work) =>
				Effect.suspend(() => {
					const before = touched,
						written = writes;
					return Effect.ensuring(
						work,
						Effect.sync(() => {
							if (writes === written) touched = before;
						})
					);
				}),
			read,
			write,
			transaction,
			rows: (schema, statement) =>
				Effect.flatMap(read_one(statement), (row) => decodeRows(schema, row)),
			one: (schema, statement) =>
				Effect.flatMap(read_one(statement), (row) => decodeOne(schema, row)),
			value: (schema, statement) =>
				Effect.flatMap(read_one(statement), (row) => decodeValue(schema, row)),
			returning: (schema, statement, lock) =>
				Effect.flatMap(write(statement, lock), (r) => decodeRows(schema, r))
		};
	};
}
