/// <reference types="node" />
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import pg from 'pg';
import { Effect, Option, Schema } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import { logStatements, type Sql, type StoreError } from '@norbital-ai/store';
import { applyAuditMigrations, readAuditMigrations } from './audit-migrations.ts';
import { PgliteDb } from './db/pglite.ts';
import { PostgresDb } from './db/postgres.ts';
import {
	AuditEvent,
	AuditPendingQuery,
	AuditPreparedRecord,
	AuditQuery,
	AuditRecord,
	AuditSummary,
	type AuditPort
} from '../protocol/audit.ts';
import { dbError } from '../engine/db/wire.ts';

const Cursor = Schema.Struct({
	fingerprint: Schema.String,
	at: Schema.String,
	id: Schema.NonEmptyString
});
const PageRows = Schema.Array(Schema.Struct({ summary: AuditSummary, position: Schema.String }));
const PendingRows = Schema.Array(
	Schema.Struct({ record: AuditPreparedRecord, position: Schema.String })
);
const DetailRows = Schema.Array(Schema.Struct({ record: AuditRecord }));
const instant = (value: string) => Number.isFinite(Date.parse(value));
const execute = async (pg: PGlite, statement: Effect.Effect<Sql, StoreError>) => {
	const sql = await Effect.runPromise(statement);
	return pg.query<unknown>(
		sql.text,
		sql.params.map((value) =>
			value !== null && typeof value === 'object' ? JSON.stringify(value) : value
		)
	);
};
const fingerprintOf = (scope: string, filter: unknown) =>
	createHash('sha256')
		.update(JSON.stringify([scope, filter]))
		.digest('hex');
const cursorOf = (fingerprint: string, at: string, id: string) =>
	Buffer.from(JSON.stringify({ fingerprint, at, id })).toString('base64url');
const readCursor = (after: string, fingerprint: string) => {
	const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))(
		Buffer.from(after, 'base64url').toString('utf8')
	);
	if (
		Option.isNone(decoded) ||
		decoded.value.fingerprint !== fingerprint ||
		!instant(decoded.value.at)
	)
		throw new FacilityFailure({
			kind: 'invalid',
			message: 'The audit cursor is invalid or belongs to another query or workspace.'
		});
	return decoded.value;
};

/** Factory maintenance after writers stop: retire every namespace in one platform, then purge payloads in bounded batches. */
export const purgePostgresAuditPartition = (
	options: { readonly url: string; readonly platform: string },
	signal?: AbortSignal
): Promise<{ readonly retired: number; readonly removed: number }> =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const pool = yield* Effect.acquireRelease(
					Effect.try({
						try: () =>
							new pg.Pool({
								connectionString: options.url,
								max: 1,
								connectionTimeoutMillis: 5000,
								statement_timeout: 5000,
								lock_timeout: 5000,
								idle_in_transaction_session_timeout: 5000
							}),
						catch: dbError
					}),
					(pool) => Effect.tryPromise({ try: () => pool.end(), catch: dbError }).pipe(Effect.orDie)
				);
				const db = PostgresDb.make(pool);
				const migrations = yield* readAuditMigrations(true);
				yield* applyAuditMigrations(db, migrations);
				const commands = yield* logStatements(migrations.spec);
				let after: string | undefined;
				let retired = 0,
					removed = 0;
				for (;;) {
					const tenants = yield* db.rows(
						Schema.Struct({ tenant: Schema.NonEmptyString }),
						yield* commands.tenants(options.platform, after)
					);
					for (const { tenant } of tenants) {
						const scope = [options.platform, tenant];
						yield* db.write(yield* commands.retire(scope));
						retired++;
						for (;;) {
							const rows = yield* db.returning(
								Schema.Struct({ removed: Schema.Int }),
								yield* commands.purge(scope)
							);
							const count = rows[0]?.removed ?? 0;
							removed += count;
							if (count < migrations.spec.retention.batch) break;
						}
					}
					const last = tenants.at(-1);
					if (last === undefined) return { retired, removed };
					after = last.tenant;
				}
			})
		),
		{ signal }
	);

/** A separate, scope-owned local audit database. No tenant adapter or ambient transaction enters this driver. */
export const localAudit = Effect.fn('bolt.localAudit')(function* (dataDir: string) {
	const owner = yield* Effect.acquireRelease(
		Effect.sync(() => {
			const directory = resolve(dataDir);
			let disposed = false;
			let opening:
				| Promise<{
						pg: PGlite;
						scope: string;
						commands: Effect.Success<ReturnType<typeof logStatements>>;
				  }>
				| undefined;
			const active = new Set<Promise<unknown>>();
			const open = () => {
				opening ??= (async () => {
					await mkdir(directory, { recursive: true });
					const scope = await realpath(directory);
					const pg = await PGlite.create({
						dataDir: scope,
						extensions: { pg_trgm },
						relaxedDurability: false
					});
					try {
						const existing = await pg.query<unknown>(`SELECT c.relname FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','bolt_audit')
              AND NOT (n.nspname='public' AND c.relname='store_migration')
              AND c.relkind IN ('r','p','v','m','f','S') LIMIT 1`);
						if (existing.rows.length !== 0)
							throw new Error(
								'The local audit database must be separate from tenant and system databases.'
							);
						await pg.exec(
							"SET TIME ZONE 'UTC'; SET statement_timeout='15s'; SET lock_timeout='5s';"
						);
						const migrations = await Effect.runPromise(readAuditMigrations(false));
						await Effect.runPromise(applyAuditMigrations(PgliteDb.make(pg), migrations));
						const commands = await Effect.runPromise(logStatements(migrations.spec));
						return { pg, scope, commands };
					} catch (error) {
						await pg.close();
						throw error;
					}
				})();
				return opening;
			};
			const use = <A>(
				signal: AbortSignal,
				body: (
					pg: PGlite,
					scope: string,
					commands: Effect.Success<ReturnType<typeof logStatements>>
				) => Promise<A>
			): Promise<A> => {
				if (disposed) return Promise.reject(new Error('The local audit database is closed.'));
				const work = (async () => {
					signal.throwIfAborted();
					const { pg, scope, commands } = await open();
					signal.throwIfAborted();
					// Each native statement is bounded; expired rows never enter query/detail/recovery answers.
					await execute(pg, commands.expire());
					signal.throwIfAborted();
					const result = await body(pg, scope, commands);
					signal.throwIfAborted();
					return result;
				})();
				active.add(work);
				void work.then(
					() => active.delete(work),
					() => active.delete(work)
				);
				return work;
			};
			const port: AuditPort = {
				mode: 'durable',
				append: (input, signal) =>
					use(signal, async (pg, _scope, commands) => {
						const events = Schema.decodeUnknownSync(Schema.Array(AuditEvent))(input);
						if (events.some((event) => !instant(event.at)))
							throw new Error('Audit occurrence time must be a valid timestamp.');
						if (events.length !== 0) await execute(pg, commands.append([], events));
					}),
				query: (input, signal) =>
					use(signal, async (pg, scope, commands) => {
						const x = Schema.decodeUnknownSync(AuditQuery)(input),
							order = x.order ?? 'newest',
							limit = x.limit ?? 100;
						const fingerprint = fingerprintOf(scope, {
							order,
							since: x.since ?? null,
							until: x.until ?? null,
							text: x.text ?? null,
							actorKind: x.actorKind ?? null,
							actorId: x.actorId ?? null,
							category: x.category ?? null,
							action: x.action ?? null,
							status: x.status ?? null,
							model: x.model ?? null,
							record: x.record ?? null,
							invocation: x.invocation ?? null,
							run: x.run ?? null
						});
						const after = x.after === undefined ? undefined : readCursor(x.after, fingerprint);
						const filters: ReadonlyArray<readonly [readonly string[], string | undefined]> = [
							[['actor', 'kind'], x.actorKind],
							[['actor', 'id'], x.actorId],
							[['category'], x.category],
							[['action'], x.action],
							[['status'], x.status],
							[['subject', 'model'], x.model],
							[['subject', 'id'], x.record],
							[['invocation'], x.invocation],
							[['run'], x.run]
						];
						const result = await execute(
							pg,
							commands.query([], {
								order,
								limit,
								...(after === undefined ? {} : { after }),
								...(x.since === undefined ? {} : { since: x.since }),
								...(x.until === undefined ? {} : { until: x.until }),
								...(x.text === undefined ? {} : { text: x.text }),
								exact: filters.flatMap(([path, value]) =>
									value === undefined ? [] : [{ path, value }]
								)
							})
						);
						const rows = Schema.decodeUnknownSync(PageRows)(result.rows),
							page = rows.slice(0, limit),
							last = page.at(-1);
						return {
							rows: page.map((row) => row.summary),
							next:
								rows.length <= limit || last === undefined
									? null
									: cursorOf(fingerprint, last.position, last.summary.id)
						};
					}),
				detail: (id, signal) =>
					use(signal, async (pg, _scope, commands) => {
						const result = await execute(pg, commands.detail([], id));
						return Schema.decodeUnknownSync(DetailRows)(result.rows)[0]?.record ?? null;
					}),
				pending: (input, signal) =>
					use(signal, async (pg, scope, commands) => {
						const x = Schema.decodeUnknownSync(AuditPendingQuery)(input),
							limit = x.limit ?? 100;
						const fingerprint = fingerprintOf(scope, 'pending');
						const after = x.after === undefined ? undefined : readCursor(x.after, fingerprint);
						const result = await execute(
							pg,
							commands.pending([], { limit, ...(after === undefined ? {} : { after }) })
						);
						const rows = Schema.decodeUnknownSync(PendingRows)(result.rows),
							page = rows.slice(0, limit),
							last = page.at(-1);
						return {
							rows: page.map((row) => row.record),
							next:
								rows.length <= limit || last === undefined
									? null
									: cursorOf(fingerprint, last.position, last.record.id)
						};
					})
			};
			return {
				port,
				close: async () => {
					disposed = true;
					await Promise.allSettled([...active]);
					if (opening === undefined) return;
					const opened = await opening.then(
						(value) => value,
						() => undefined
					);
					if (opened !== undefined) await opened.pg.close();
				}
			};
		}),
		(owner) =>
			Effect.tryPromise({ try: owner.close, catch: dbError }).pipe(
				Effect.uninterruptible,
				Effect.orDie
			)
	);
	return owner.port;
});
