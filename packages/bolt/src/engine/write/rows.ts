// Write-side row reads, visibility checks, upsert lookup, dry-run rollback, and the transform read bridge.
import { Effect, Predicate, Schema } from 'effect';
import type { Lock, Sql } from '@norbital-ai/host-api';
import {
	canonical,
	compile_gets,
	database_value,
	null_row_sql,
	q,
	type Catalog,
	type ConstraintMeta,
	type SelectIR
} from '@norbital-ai/store';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { readsAny, writePredicates } from '../access/authority.ts';
import { catalog_of } from '../access/pred.ts';
import type { Authority, Bindings, CrossAnswer, Invocation, RowData } from '../contracts.ts';
import { storedRows } from '../db/rows.ts';
import { storedRowSql } from '../db/stored.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import type { EngineError } from '../errors.ts';
import type { EngineManifest } from '../manifest.ts';
import { read_composed, read_engine, ReadDeps, readTargets } from '../query/engine.ts';
import { read_history } from '../query/history.ts';
import { composable, readOptions, scopeOf } from '../query/reader.ts';
import type { Bridge } from '../services.ts';
import type { Item } from './flatten.ts';
import { CommitAnswer, LOST_OUTCOME } from './result.ts';
import { k, treeSelect, writeTree, type ReadVisibility } from './shared.ts';
import { decideError, fingerprinting, type Fingerprint } from './sql.ts';

/** The caller's read scope admits the row, as the act's own native read found it (an administrator reads all). */
export function readableBy(
	auth: Authority,
	c: string,
	row: RowData,
	visibility: ReadonlyMap<string, boolean>
): boolean {
	return auth.admin || (typeof row['id'] === 'string' && visibility.get(k(c, row['id'])) === true);
}
/** The scope of the policies granting `verb` admits the row (`writePredicates`), as the act's native read found it. */
export function writableBy(
	auth: Authority,
	verb: 'update' | 'delete',
	c: string,
	row: RowData,
	writable: ReadonlyMap<string, boolean>
): boolean {
	return (
		auth.admin ||
		(typeof row['id'] === 'string' && writable.get(k(verb, k(c, row['id']))) === true)
	);
}

/**
 * Reads raw rows and, with a caller `scope`, which of them its native read scope admits, keyed `model␀id`: a row any
 * output the caller holds admits. Only a model the caller reads is checked; any other row is not readable. The two reads
 * are issued together (one round trip over a coalescing reader); the visibility read is fingerprinted.
 */
export const readRows = Effect.fn('Bolt.readRows')(function* (
	db: TenantDb,
	cat: Catalog,
	want: readonly (readonly [string, string])[],
	scope?: ReadVisibility
): Effect.fn.Return<Map<string, RowData>, EngineError> {
	const grouped = [...Map.groupBy(want, ([c]) => c)];
	if (grouped.length === 0) return new Map();
	const tables = grouped.map(([table]) => table);
	const checks =
		scope === undefined || scope.authority.admin
			? []
			: tables.filter((table) => readsAny(scope.authority, table));
	const writes: readonly ('update' | 'delete')[] =
		scope?.writable === undefined ? [] : ['update', 'delete'];
	const reads = checks.flatMap((table) => [
		[table, undefined] as const,
		...writes
			.filter(
				(verb) =>
					scope !== undefined && (writePredicates(scope.authority, table, verb)?.length ?? 0) > 0
			)
			.map((verb) => [table, verb] as const)
	]);
	const visible = yield* Effect.forEach(reads, ([table, verb]) => {
		if (scope === undefined)
			return Effect.fail(
				BoltError.make('internal', 'admission', 'read visibility requires its caller scope')
			);
		const ids = [...new Set(want.filter(([model]) => model === table).map(([, id]) => id))];
		for (const id of ids) scope.visibility.set(k(table, id), false);
		const { authority } = scope;
		return compile_gets(
			cat,
			table,
			ids,
			{ fields: ['id'], relations: {} },
			{
				...readOptions({ as: 'caller', authority }, scope.bindings),
				scope:
					verb === undefined
						? scopeOf(authority, 'any')
						: {
								rows: (path) => (path === table ? writePredicates(authority, table, verb) : undefined)
							}
			}
		).pipe(Effect.map(composable), Effect.mapError(from_store));
	});
	const recorded = fingerprinting(db);
	const [res, seen] = yield* Effect.all(
		[
			read_composed(
				db,
				grouped.map(([t, targets]) =>
					composable({
						text: `SELECT ${storedRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(${null_row_sql(t, cat.models.get(t)?.fields.keys() ?? [])}, $1::jsonb) r ON t.id = r.id`,
						params: [
							JSON.stringify([...new Set(targets.map(([, id]) => id))].map((id) => ({ id })))
						]
					})
				)
			),
			visible.length === 0 ? Effect.succeed([]) : read_composed(recorded.db, visible)
		],
		{ concurrency: 'unbounded' }
	);
	scope?.fingerprints.push(...recorded.fingerprints());
	for (const [index, [table, verb]] of reads.entries())
		for (const row of seen[index]?.rows ?? []) {
			const value = row['j'];
			if (!Predicate.isObject(value) || typeof value['id'] !== 'string') continue;
			if (verb === undefined) scope?.visibility.set(k(table, value['id']), true);
			else scope?.writable?.set(k(verb, k(table, value['id'])), true);
		}
	const rows = new Map<string, RowData>();
	for (const [index, table] of tables.entries())
		for (const row of yield* storedRows(cat, table, res[index])) rows.set(k(table, row.id), row);
	return rows;
});

export const wireRows = Effect.fn('Bolt.wireRows')(function* (
	db: TenantDb,
	cat: Catalog,
	c: string,
	ids: readonly (string | null)[],
	b: Bindings,
	select: SelectIR = { fields: null, relations: {} },
	writeScope?: { readonly authority: Authority; readonly verb: 'update' | 'delete' }
) {
	const want = ids.filter((id) => id !== null);
	if (want.length === 0) return ids.map(() => null);
	const preds =
		writeScope === undefined
			? undefined
			: writePredicates(writeScope.authority, c, writeScope.verb);
	if (preds !== undefined && preds.length === 0) return ids.map(() => null);
	const [res] = yield* db.read([
		composable(
			yield* compile_gets(
				cat,
				c,
				want,
				select,
				writeScope === undefined
					? readOptions({ as: 'workspace' }, b)
					: {
							...readOptions({ as: 'caller', authority: writeScope.authority }, b),
							scope: { rows: (path) => (path === c ? preds : undefined) }
						}
			).pipe(Effect.mapError(from_store))
		)
	]);
	if (res === undefined)
		return yield* BoltError.make('internal', 'decode', 'A stored tree read returned no result.');
	const rows = yield* Schema.decodeUnknownEffect(
		Schema.Array(
			Schema.Struct({
				j: Schema.NullOr(
					Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
						Schema.Record(Schema.String, Schema.Json)
					])
				)
			})
		)
	)(res.rows).pipe(Effect.mapError((error) => BoltError.make('internal', 'decode', error.message)));
	const byId = new Map<string, RowData>();
	for (const { j } of rows) if (j !== null) byId.set(j.id, j);
	return ids.map((id) => (id === null ? null : (byId.get(id) ?? null)));
});

/** The stored trees a verdict or transform receives, in `ids` order (`null` where no row is stored). */
export const storedTrees = (
	db: TenantDb,
	m: EngineManifest,
	cat: Catalog,
	model: string,
	ids: readonly (string | null)[],
	b: Bindings,
	paths = Object.keys(m.exposures[model]?.update?.columns ?? {}),
	writeScope?: { readonly authority: Authority; readonly verb: 'update' | 'delete' }
) =>
	wireRows(db, cat, model, ids, b, treeSelect(cat, paths, model, model), writeScope).pipe(
		Effect.flatMap((rows) =>
			Effect.try({
				try: () => rows.map((row) => writeTree(cat, model, row)),
				catch: (error) =>
					error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
			})
		)
	);

const required = (m: EngineManifest, model: string, field: string): boolean => {
	const kind = m.models[model]?.fields[field],
		rel = m.relationships[`${model}.${field}`];
	return kind !== undefined ? kind.optional !== true : rel !== undefined && rel.optional !== true;
};

export const resolveUpserts = Effect.fn('Bolt.resolveUpserts')(function* (
	db: TenantDb,
	m: EngineManifest,
	upserts: readonly Item[]
) {
	const found = new Map<Item, RowData>();
	const byTable = new Map<
		string,
		{ on: readonly string[]; items: { item: Item; values: RowData }[] }
	>();
	for (const item of upserts) {
		const change = item.change;
		if (change.op !== 'upsert')
			return yield* Effect.fail(
				BoltError.make('internal', 'decode', 'an upsert lookup received another write')
			);
		const group = byTable.get(change.model);
		const entry = { item, values: change.values };
		if (group === undefined) byTable.set(change.model, { on: change.on, items: [entry] });
		else group.items.push(entry);
	}
	if (byTable.size === 0) return found;
	const tables = [...byTable];
	const cat = catalog_of(m);
	const raw = yield* read_composed(
		db,
		tables.map(([t, { on, items }]) =>
			composable({
				text: `SELECT DISTINCT ${storedRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(${null_row_sql(t, cat.models.get(t)?.fields.keys() ?? [])}, $1::jsonb) r
			ON ${on.map((f) => `t.${q(f)} ${required(m, t, f) ? '=' : 'IS NOT DISTINCT FROM'} r.${q(f)}`).join(' AND ')}`,
				params: [
					JSON.stringify(
						items.map(({ values }) =>
							Object.fromEntries(
								on.map((field) => [
									field,
									database_value(values[field] ?? null, cat.models.get(t)?.fields.get(field))
								])
							)
						)
					)
				]
			})
		)
	);
	for (const [index, [table, { on, items }]] of tables.entries()) {
		const rows = yield* storedRows(cat, table, raw[index]);
		const indexed = new Map(
			rows.map((row) => [canonical(on.map((field) => String(row[field] ?? null))), row])
		);
		for (const { item, values } of items) {
			const row = indexed.get(
				canonical(on.map((field) => String(database_value(values[field] ?? null))))
			);
			if (row !== undefined) found.set(item, row);
		}
	}
	return found;
});

/** Runs a commit's statements and rolls them back: an import preview's outcome. */
export const dry_run = Effect.fn('Bolt.dry_run')(function* (
	db: TenantDb,
	statements: readonly Sql[],
	lock: Lock | undefined,
	meta: ReadonlyMap<string, ConstraintMeta>
) {
	return yield* db
		.transaction({ statements, rollback: true, ...(lock === undefined ? {} : { lock }) })
		.pipe(
			Effect.flatMap((rows) =>
				Schema.decodeUnknownEffect(CommitAnswer)(rows[statements.length - 1]?.rows[0]).pipe(
					Effect.mapError((error) => BoltError.make('bad_answer', 'commit', error.message, error)),
					Effect.map((answer) => answer.outcome ?? LOST_OUTCOME)
				)
			),
			Effect.catch((error) =>
				error instanceof BoltError
					? Effect.fail(error)
					: decideError(error, meta).pipe(Effect.map((decision) => decision.outcome))
			)
		);
});

/** Workspace reads shared by direct writes and verbs recorded in an atomic batch. */
export function transformBridge(
	manifest: EngineManifest,
	db: TenantDb,
	invocation: Invocation
): Bridge & { tables(): readonly string[]; fingerprints(): readonly Fingerprint[] } {
	const tables = new Set<string>();
	const recorded = fingerprinting(db);
	const reader = read_engine({
		db: recorded.db,
		manifest,
		delegate: {
			history: (read, who, bindings) =>
				read.kind === 'history'
					? read_history(recorded.db, manifest, read, who, bindings)
					: Effect.fail(BoltError.make('invalid', 'decode', 'Expected a history read.'))
		}
	});
	const bindings: Bindings = {
		now: invocation.ctx.now,
		today: invocation.ctx.today,
		tz: invocation.ctx.tz
	};
	return {
		tables: () => [...tables],
		fingerprints: recorded.fingerprints,
		cross: (calls) =>
			Effect.gen(function* () {
				type ReadCall = Extract<Parameters<Bridge['cross']>[0][number], { _tag: 'read' }>;
				const groups = new Map<string, { reads: { index: number; read: ReadCall['read'] }[] }>();
				const answers = calls.map(
					(call): CrossAnswer => ({
						ok: false,
						error: {
							kind: 'bolt',
							code: 'unsupported',
							message: `a write callback cannot ${call._tag}`
						}
					})
				);
				for (const [index, call] of calls.entries()) {
					if (call._tag !== 'read') continue;
					for (const table of readTargets(reader.catalog, call.read)) tables.add(table);
					const cte =
						call.read.kind === 'read' || call.read.kind === 'get' ? call.read.cte : undefined;
					const scope = cte === undefined ? index : cte.split(':', 1)[0];
					const key = canonical(scope ?? index);
					let group = groups.get(key);
					if (group === undefined) {
						group = { reads: [] };
						groups.set(key, group);
					}
					group.reads.push({ index, read: call.read });
				}
				yield* Effect.forEach(
					[...groups.values()],
					(group) =>
						reader
							.run(
								group.reads.map(({ read }) => read),
								{ as: 'workspace' },
								bindings
							)
							.pipe(
								Effect.provideService(ReadDeps, tables),
								Effect.map((values) => {
									for (const [position, { index }] of group.reads.entries())
										answers[index] = { ok: true, value: values[position] ?? null };
								}),
								Effect.catch((error) =>
									Effect.sync(() => {
										for (const { index } of group.reads)
											answers[index] = {
												ok: false,
												error: {
													kind: 'bolt',
													code: error instanceof BoltError ? error.code : 'internal',
													message: error.message
												}
											};
									})
								)
							),
					{ concurrency: 'unbounded' }
				);
				return answers;
			})
	};
}
