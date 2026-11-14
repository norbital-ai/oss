// Native Postgres executes completed SQL batches. Inputs are copied before acquisition. Interruption or
// uncertain cleanup destroys the connection.
// Setup and settlement add control round trips; every supplied Sql keeps its own prepared execution and result.
import { createHash } from 'node:crypto';
import { Duration, Effect, Exit } from 'effect';
import type { Json } from '@norbital-ai/store';
import { type DbBatch, type DbError, HOST_LIMITS, type RawDb, type Rows } from '../../index.ts';
import {
	cancelled,
	copiedBatch,
	DATABASE_SETTINGS,
	db_error,
	lockStatements,
	param,
	parse
} from '../../wire.ts';

type PgResult = { rows: { [column: string]: Json }[]; rowCount: number | null };
type PgQuery = {
	text: string;
	name?: string;
	values?: (string | null)[];
	types: { getTypeParser: (oid: number) => (s: string) => Json };
};
/** The part of a `pg` pool client the native database uses. */
export type PgClient = {
	query(q: PgQuery): Promise<PgResult | PgResult[]>;
	release(destroy?: boolean): void;
	end?(): Promise<void>;
	connection?: { readonly stream: { destroy(): void } };
	on?(event: 'error' | 'end', listener: (error?: unknown) => void): unknown;
	removeListener?(event: 'error' | 'end', listener: (error?: unknown) => void): unknown;
};
type PgPool = { connect(): Promise<PgClient> };

const types = { getTypeParser: (oid: number) => (s: string) => parse(oid, s) };
const NONE: PgResult = { rows: [], rowCount: 0 };
const last = (r: PgResult | PgResult[]): PgResult =>
	Array.isArray(r) ? (r[r.length - 1] ?? NONE) : r;
const rowsOf = (r: PgResult): Rows => ({ rows: r.rows, affected: r.rowCount ?? r.rows.length });

const listened = new WeakSet<PgClient>();
/**
 * pg-pool listens to a client only while it idles: a connection dropped under a checkout would be an uncaught 'error',
 * stopping the host and every workspace on it. The call in flight already fails with it.
 */
const checkout = async (pool: PgPool) => {
	const client = await pool.connect();
	if (!listened.has(client)) {
		listened.add(client);
		client.on?.('error', () => undefined);
	}
	return client;
};

/** The adapter's calls over `pool`; its statement names live as long as it does. */
function raw(pool: PgPool): RawDb {
	const names = new Map<string, string>();
	const named = (text: string): string => {
		let name = names.get(text);
		if (name === undefined) {
			name = `b${createHash('sha1').update(text).digest('base64url')}`;
			if (names.size >= 10_000) names.clear(); // ponytail: shapes are finite per artifact; an LRU if this churns
			names.set(text, name);
		}
		return name;
	};
	const query = (client: PgClient, q: PgQuery) =>
		Effect.tryPromise({ try: () => client.query(q), catch: db_error });
	const send = (client: PgClient, text: string) => query(client, { text, types });
	const single = (client: PgClient, statement: PgQuery) =>
		Effect.map(query(client, statement), (result) => rowsOf(last(result)));
	/** Interruptible pool acquisition disposes a connection even if the pool answers after cancellation. */
	const acquire = Effect.tryPromise({
		try: async (signal) => {
			const client = await checkout(pool);
			if (signal.aborted) {
				client.release(true);
				throw cancelled();
			}
			return client;
		},
		catch: db_error
	});
	const run = (
		batch: DbBatch,
		readOnly: boolean = false
	): Effect.Effect<readonly Rows[], DbError> =>
		Effect.try({
			try: () => {
				const prepared = copiedBatch(batch);
				const statements: PgQuery[] = prepared.statements.map((statement) => ({
					text: statement.text,
					...(statement.params.length === 0
						? {}
						: { name: named(statement.text), values: statement.params.map(param) }),
					types
				}));
				const begin = [
					readOnly ? 'begin isolation level repeatable read read only' : 'begin',
					...DATABASE_SETTINGS,
					...lockStatements(prepared.lock)
				].join(';\n');
				return { statements, begin, end: prepared.rollback === true ? 'rollback' : 'commit' };
			},
			catch: db_error
		}).pipe(
			Effect.flatMap((prepared) =>
				Effect.scoped(
					Effect.gen(function* () {
						let uncertain = false;
						const client = yield* Effect.acquireRelease(
							acquire,
							(client, exit) =>
								Effect.sync(() => client.release(uncertain || Exit.hasInterrupts(exit))),
							{ interruptible: true }
						);
						const rollback = send(client, 'rollback').pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									uncertain = false;
								})
							),
							Effect.tapCause(Effect.logWarning),
							Effect.ignore
						);
						return yield* Effect.gen(function* () {
							uncertain = true;
							yield* send(client, prepared.begin);
							const results = yield* Effect.forEach(prepared.statements, (statement) =>
								single(client, statement)
							);
							yield* send(client, prepared.end);
							uncertain = false;
							return results;
						}).pipe(Effect.tapError(() => rollback));
					})
				).pipe(
					Effect.timeoutOrElse({
						duration: Duration.millis(HOST_LIMITS.callMs.database),
						orElse: () => Effect.fail(cancelled())
					})
				)
			)
		);
	return {
		read: (statements) => run({ statements }, true),
		write: (statement, lock) =>
			run({ statements: [statement], ...(lock === undefined ? {} : { lock }) }).pipe(
				Effect.map((rows) => rows[0] ?? { rows: [], affected: 0 })
			),
		transaction: (batch) => run(batch)
	};
}

/** The tenant database adapter over a host-owned `pg` pool, as deployed hosts use. */
export const PostgresDb = {
	/** The adapter over a pool the host keeps (a multi-workspace host shares its pool across a cell's work); each batch
	 * owns a connection until settlement. */
	make: raw
};
