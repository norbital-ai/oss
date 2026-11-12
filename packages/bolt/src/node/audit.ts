/// <reference types="node" />
import { createHash } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Effect, Option, Result, Schema } from 'effect';
import { FacilityFailure, Unavailable } from '../decl/errors.ts';
import { log_statements, type Sql, type StoreError } from '@norbital-ai/store';
import { apply_audit_migrations, read_audit_migrations } from './audit-migrations.ts';
import { PgliteDb, Pristine } from './db/pglite.ts';
import { PostgresDb } from './db/postgres.ts';
import {
	AuditEvent,
	AuditPendingQuery,
	AuditQuery,
	type AuditPort
} from '../protocol/audit.ts';
import { db_error } from '../engine/db/wire.ts';
import { StoredAuditSummary, StoredAuditRecord, StoredAuditPreparedRecord, storedAuditEvent, auditSummary, auditRecord, auditPreparedRecord } from './audit-storage.ts';

const Cursor = Schema.Struct({
	fingerprint: Schema.String,
	at: Schema.String,
	id: Schema.NonEmptyString
});
const PageRows = Schema.Array(Schema.Struct({ summary: StoredAuditSummary, position: Schema.String }));
const PendingRows = Schema.Array(
	Schema.Struct({ record: StoredAuditPreparedRecord, position: Schema.String })
);
const DetailRows = Schema.Array(Schema.Struct({ record: StoredAuditRecord }));
const instant = (value: string) => Number.isFinite(Date.parse(value));
/** One native statement; the fiber waits for it before an interruption lands, so `close` never races it. */
const native = <A>(work: () => Promise<A>) =>
	Effect.uninterruptible(Effect.tryPromise({ try: work, catch: db_error }));
const execute = (pg: PGlite, statement: Effect.Effect<Sql, StoreError>) =>
	Effect.flatMap(statement, (sql) =>
		native(() =>
			pg.query<unknown>(
				sql.text,
				sql.params.map((value) =>
					value !== null && typeof value === 'object' ? JSON.stringify(value) : value
				)
			)
		)
	);
const decodeAs =
	<A, I>(schema: Schema.Codec<A, I>, kind: 'invalid' | 'upstream') =>
	(input: unknown) =>
		Schema.decodeUnknownEffect(schema)(input).pipe(
			Effect.mapError((error) => new FacilityFailure({ kind, message: error.message }))
		);
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
	return Option.isNone(decoded) ||
		decoded.value.fingerprint !== fingerprint ||
		!instant(decoded.value.at)
		? Effect.fail(
				FacilityFailure.invalid('The audit cursor is invalid or belongs to another query or workspace.')
			)
		: Effect.succeed(decoded.value);
};

/** Factory maintenance after writers stop: retire every namespace in one platform, then purge payloads in bounded batches. */
export const purge_postgres_audit_partition = (
	options: { readonly url: string; readonly platform: string },
	signal?: AbortSignal
): Promise<{ readonly retired: number; readonly removed: number }> =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const pool = yield* Effect.acquireRelease(
					// the driver is a deployment choice, not a tooling dependency: load it only where this runs
					Effect.tryPromise({
						try: async () => {
							const { default: pg } = await import('pg');
							return new pg.Pool({
								connectionString: options.url,
								max: 1,
								connectionTimeoutMillis: 5000,
								statement_timeout: 5000,
								lock_timeout: 5000,
								idle_in_transaction_session_timeout: 5000
							});
						},
						catch: db_error
					}),
					(pool) => Effect.tryPromise({ try: () => pool.end(), catch: db_error }).pipe(Effect.orDie)
				);
				const db = PostgresDb.make(pool);
				const migrations = yield* read_audit_migrations(true);
				yield* apply_audit_migrations(db, migrations);
				const commands = yield* log_statements(migrations.spec);
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

type Opened = {
	readonly pg: PGlite;
	readonly scope: string;
	readonly commands: Effect.Success<ReturnType<typeof log_statements>>;
};
/** The audit database at `directory`, migrated; a database holding anything else is refused and closed. */
const open_audit = (directory: string) =>
	Effect.gen(function* () {
		yield* native(() => mkdir(directory, { recursive: true }));
		const scope = yield* native(() => realpath(directory));
		// a new directory starts from the machine's initdb dump (~13× cheaper than initdb)
		const fresh = yield* Effect.promise(() =>
			access(join(scope, 'PG_VERSION')).then(
				() => false,
				() => true
			)
		);
		const loadDataDir = fresh
			? Option.some(yield* Pristine.pipe(Effect.flatten, Effect.provide(Pristine.layer)))
			: Option.none<Blob>();
		const pg = yield* native(() =>
			PGlite.create({
				dataDir: scope,
				...(Option.isSome(loadDataDir) ? { loadDataDir: loadDataDir.value } : {}),
				extensions: { pg_trgm },
				relaxedDurability: false
			})
		);
		return yield* Effect.gen(function* () {
			const existing = yield* native(() =>
				pg.query<unknown>(`SELECT c.relname FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','bolt_audit')
              AND NOT (n.nspname='public' AND c.relname='store_migration')
              AND c.relkind IN ('r','p','v','m','f','S') LIMIT 1`)
			);
			if (existing.rows.length !== 0)
				return yield* Effect.fail(
					FacilityFailure.invalid(
						'The local audit database must be separate from tenant and system databases.'
					)
				);
			yield* native(() =>
				pg.exec("SET TIME ZONE 'UTC'; SET statement_timeout='15s'; SET lock_timeout='5s';")
			);
			const migrations = yield* read_audit_migrations(false);
			yield* apply_audit_migrations(PgliteDb.make(pg), migrations);
			const commands = yield* log_statements(migrations.spec);
			const opened: Opened = { pg, scope, commands };
			return opened;
		}).pipe(Effect.onError(() => Effect.ignore(Effect.tryPromise(() => pg.close()))));
	});

/** A separate, scope-owned local audit database. No tenant adapter or ambient transaction enters this driver. */
export const local_audit = Effect.fn('bolt.local_audit')(function* (dataDir: string) {
	let disposed = false;
	let opened: Opened | undefined;
	const active = new Set<Promise<unknown>>();
	const open = yield* Effect.cached(
		Effect.uninterruptible(open_audit(resolve(dataDir))).pipe(
			Effect.tap((value) =>
				Effect.sync(() => {
					opened = value;
				})
			)
		)
	);
	/** The port's one adapter: a call runs once, failing with its own typed error. */
	const use = <A, E>(signal: AbortSignal, body: (opened: Opened) => Effect.Effect<A, E>): Promise<A> => {
		const work = Effect.runPromise(
			Effect.result(
				Effect.gen(function* () {
					if (disposed)
						return yield* Effect.fail(
							new Unavailable({ facility: 'audit', reason: 'The local audit database is closed.' })
						);
					const at = yield* open;
					// Each native statement is bounded; expired rows never enter query/detail/recovery answers.
					yield* execute(at.pg, at.commands.expire());
					return yield* body(at);
				})
			),
			{ signal }
		).then(Result.getOrThrow);
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
			use(signal, ({ pg, commands }) =>
				Effect.gen(function* () {
					const events = yield* decodeAs(Schema.Array(AuditEvent), 'invalid')(input);
					if (events.some((event) => !instant(event.at)))
						return yield* Effect.fail(
							FacilityFailure.invalid('Audit occurrence time must be a valid timestamp.')
						);
					if (events.length !== 0)
						yield* execute(pg, commands.append([], events.map(storedAuditEvent)));
				})
			),
		query: (input, signal) =>
			use(signal, ({ pg, scope, commands }) =>
				Effect.gen(function* () {
					const x = yield* decodeAs(AuditQuery, 'invalid')(input),
						order = x.order ?? 'newest',
						limit = x.limit ?? 100;
					// Cursor fingerprints retain the private format:1 filter names.
					const fingerprint = fingerprintOf(scope, {
						order,
						since: x.since ?? null,
						until: x.until ?? null,
						text: x.text ?? null,
						actorKind: x.actor_kind ?? null,
						actorId: x.actor_id ?? null,
						category: x.category ?? null,
						action: x.action ?? null,
						status: x.status ?? null,
						model: x.model ?? null,
						record: x.record ?? null,
						invocation: x.invocation ?? null,
						run: x.run ?? null
					});
					const after =
						x.after === undefined ? undefined : yield* readCursor(x.after, fingerprint);
					const filters: ReadonlyArray<readonly [readonly string[], string | undefined]> = [
						[['actor', 'kind'], x.actor_kind],
						[['actor', 'id'], x.actor_id],
						[['category'], x.category],
						[['action'], x.action],
						[['status'], x.status],
						[['subject', 'model'], x.model],
						[['subject', 'id'], x.record],
						[['invocation'], x.invocation],
						[['run'], x.run]
					];
					const result = yield* execute(
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
					const rows = yield* decodeAs(PageRows, 'upstream')(result.rows),
						page = rows.slice(0, limit),
						last = page.at(-1);
					return {
						rows: page.map((row) => auditSummary(row.summary)),
						next:
							rows.length <= limit || last === undefined
								? null
								: cursorOf(fingerprint, last.position, last.summary.id)
					};
				})
			),
		detail: (id, signal) =>
			use(signal, ({ pg, commands }) =>
				execute(pg, commands.detail([], id)).pipe(
					Effect.flatMap((result) => decodeAs(DetailRows, 'upstream')(result.rows)),
					Effect.map(([row]) => (row === undefined ? null : auditRecord(row.record)))
				)
			),
		pending: (input, signal) =>
			use(signal, ({ pg, scope, commands }) =>
				Effect.gen(function* () {
					const x = yield* decodeAs(AuditPendingQuery, 'invalid')(input),
						limit = x.limit ?? 100;
					const fingerprint = fingerprintOf(scope, 'pending');
					const after =
						x.after === undefined ? undefined : yield* readCursor(x.after, fingerprint);
					const result = yield* execute(
						pg,
						commands.pending([], { limit, ...(after === undefined ? {} : { after }) })
					);
					const rows = yield* decodeAs(PendingRows, 'upstream')(result.rows),
						page = rows.slice(0, limit),
						last = page.at(-1);
					return {
						rows: page.map((row) => auditPreparedRecord(row.record)),
						next:
							rows.length <= limit || last === undefined
								? null
								: cursorOf(fingerprint, last.position, last.record.id)
					};
				})
			)
	};
	yield* Effect.addFinalizer(() =>
		Effect.gen(function* () {
			disposed = true;
			yield* Effect.promise(() => Promise.allSettled([...active]));
			if (opened !== undefined) {
				const { pg } = opened;
				yield* native(() => pg.close());
			}
		}).pipe(Effect.uninterruptible, Effect.orDie)
	);
	return port;
});
