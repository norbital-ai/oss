// A workspace's schema lifecycle (rule 69, X-16): the manifest as the store's schema (`schemaSlice`), with its named
// connections; the store plans from the slice the database was last planned to (`readApplied`), and `applyPlan` runs
// the plan's statements in one transaction under the schema advisory lock, the engine's own objects re-asserted.
import { Effect, Schema } from 'effect';
import {
	canonical,
	constraintIndex as storeConstraintIndex,
	destructiveSteps as storeDestructiveSteps,
	plan as storePlan,
	sha256Hex,
	statements,
	TableSpec,
	unaccepted,
	type ConstraintMeta,
	type Plan,
	type SchemaObject
} from '@norbital-ai/store';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { Sql } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { BoltError, fromStore, storeSync } from '../../protocol/errors.ts';
import { tablesOf } from '../../protocol/catalog.ts';
import { configurationDefaults } from '../../decl/runtime/integration.ts';
import { definitionOf } from '../integrations/instances.ts';
import { engineObjects } from './engine.ts';
import { auditTriggers } from './audit.ts';

/** What the database depends on: the fingerprint is over exactly this (rule 69). */
export const SchemaSliceSchema = Schema.Struct({
	tables: Schema.Record(Schema.String, TableSpec),
	tz: Schema.String,
	currency: Schema.NullOr(Schema.String),
	/** `+workspace.ts` connections, projected into their named sys_integration rows with their definitions' default configuration. */
	connections: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({
				integration: Schema.String,
				envoy: Schema.optionalKey(Schema.String),
				configuration: Schema.Json
			})
		)
	)
});
export type SchemaSlice = typeof SchemaSliceSchema.Type;

/**
 * What the database holds for a workspace: its models and relationships beside the built-in layer's (`src/system`) as
 * the store's tables, and its connections, each with the configuration its definition starts an instance with.
 */
export function schemaSlice(m: EngineManifest): SchemaSlice {
	const connections = Object.fromEntries(
		Object.entries(m.connections).map(([slot, c]) => [
			slot,
			{ ...c, configuration: configurationDefaults(definitionOf(m, c.integration)) }
		])
	);
	return {
		tables: tablesOf(m.models, m.relationships),
		currency: m.workspace.currency ?? null,
		tz: m.workspace.tz,
		connections
	};
}
/** Legacy Bolt slices used audit as the writer-owned delete marker; source bytes and fingerprints stay immutable. */
export function managedTables(tables: SchemaSlice['tables']): SchemaSlice['tables'] {
	const out: { [name: string]: SchemaSlice['tables'][string] } = {};
	for (const [name, table] of Object.entries(tables))
		out[name] =
			table.audit === true && table.nativeRules === undefined && table.managedDeletes !== true
				? { ...table, managedDeletes: true }
				: table;
	return out;
}
/** The schema hash activation compares (rule 69): SHA-256 of the canonical slice, connections included. */
export const fingerprint = (s: SchemaSlice): string => sha256Hex(canonical(s));

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const lit = (v: string): string => `'${v.replaceAll("'", "''")}'`;
const block = (body: string): Sql => ({ text: `do ${lit(body)}`, params: [] });
/**
 * A connection is its named instance: inserted once with its default envoy and configuration (runtime edits stay), as
 * an instance made at run time starts; deleted with its slot or when its slot names another definition (a new
 * instance); an instance created at run time (not named) is never touched.
 */
function connectionsObject(s: SchemaSlice): readonly SchemaObject[] {
	if (s.tables['sys_integration'] === undefined) return [];
	const slots = lit(
		JSON.stringify(
			Object.entries(s.connections ?? {}).map(([id, c]) => ({
				id,
				integration: c.integration,
				envoy: c.envoy ?? null,
				configuration: c.configuration
			}))
		)
	);
	return [
		{
			id: 'source:connections',
			rank: 'backfill',
			table: 'sys_integration',
			deps: ['id', 'integration', 'name', 'named', 'envoy', 'configuration'],
			drop: null,
			create: [
				`delete from ${q('sys_integration')} where named and (id, integration) not in (select id, integration from jsonb_to_recordset(${slots}::jsonb) as s(id text, integration text))`,
				`insert into ${q('sys_integration')} (id, integration, name, named, envoy, configuration) select id, integration, id, true, envoy, configuration
					from jsonb_to_recordset(${slots}::jsonb) as s(id text, integration text, envoy text, configuration jsonb) on conflict (id) do nothing`
			]
		}
	];
}
/** The engine's own objects beside a slice: its connections, then its private tables and functions (they come last). */
export const engineBeside = (s: SchemaSlice): readonly SchemaObject[] => [
	...connectionsObject(s),
	...engineObjects(),
	...auditTriggers(s.tables)
];

/** The slice the database was last planned to, or `null` for an empty database. */
export const readApplied = Effect.fn('Bolt.readApplied')(function* (db: TenantDbShape) {
	const [present] = yield* db.read([
		{ text: `select to_regclass('bolt_schema') is not null as present`, params: [] }
	]);
	if (present?.rows[0]?.present !== true) return null;
	const [row] = yield* db.read([{ text: 'select slice from bolt_schema', params: [] }]);
	return yield* Schema.decodeUnknownEffect(Schema.NullOr(SchemaSliceSchema))(
		row?.rows[0]?.slice ?? null
	).pipe(Effect.mapError((error) => BoltError.make('schema', 'decode', error.message, error)));
});
/** The store's plan from `applied` to the manifest's (or a given) slice, the engine's objects beside both. */
export const plan = (
	applied: SchemaSlice | null,
	next: EngineManifest | SchemaSlice
): Effect.Effect<Plan & { readonly slice: SchemaSlice }, BoltError> => {
	const slice = 'workspace' in next ? schemaSlice(next) : next;
	return storePlan(
		applied === null ? null : { ...applied, tables: managedTables(applied.tables) },
		slice,
		engineBeside
	).pipe(
		Effect.map((p) => ({
			...p,
			from: applied === null ? null : fingerprint(applied),
			to: fingerprint(slice),
			slice
		})),
		Effect.mapError(fromStore)
	);
};
/** The same schema diff's destructive ids, without rendering fixed, never-dropped search function bodies. */
export const destructiveSteps = (
	applied: SchemaSlice | null,
	next: EngineManifest | SchemaSlice
): Effect.Effect<readonly string[], BoltError> => {
	const slice = 'workspace' in next ? schemaSlice(next) : next;
	return storeDestructiveSteps(
		applied === null ? null : { ...applied, tables: managedTables(applied.tables) },
		slice,
		engineBeside
	).pipe(Effect.mapError(fromStore));
};
type ApplyOptions = {
	/** Accept every destructive step of this explicit plan, or only the named step ids. Hosts apply committed SQL migrations. */
	accept?: true | readonly string[];
};
/**
 * Applies a plan in one transaction. Refuses, before anything changes: an unaccepted destructive step, and a database
 * no longer at `plan.from` (another apply won). A validating step counts its offending rows first.
 */
export const applyPlan = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.applyPlan')(function* (
		db: TenantDbShape,
		p: Plan & { readonly slice: SchemaSlice },
		options: ApplyOptions = {}
	) {
		const refused = unaccepted(p, options.accept);
		if (refused.length > 0)
			return yield* Effect.fail(
				BoltError.make(
					'destructiveNotAccepted',
					'admission',
					`destructive schema steps need acceptance: ${refused.map((s) => s.id).join(', ')}`,
					refused.map((s) => s.id)
				)
			);
		// The first guard is self-contained: a fresh database has neither bolt_schema nor bolt_assert yet.
		const sql: Sql[] = [
			block(`declare held text; begin
			if to_regclass(${lit('bolt_schema')}) is not null then
				execute ${lit(`select ${q('fingerprint')} from ${q('bolt_schema')} where ${q('one')} = true`)} into held;
			end if;
			if held is distinct from ${p.from === null ? 'null' : lit(p.from)} then
				raise exception using errcode = 'BS001', message = json_build_object('current', held)::text;
			end if;
		end`)
		];
		for (const s of statements(p, [...engineObjects(), ...auditTriggers(p.slice.tables)])) {
			if (s.violations !== undefined)
				sql.push(
					block(`declare n bigint; begin
					execute ${lit(s.violations)} into n;
					if coalesce(n, 0) > 0 then
						raise exception using errcode = 'BS002', message = json_build_object('constraint', ${lit(s.name ?? s.step)}, 'rows', n)::text;
					end if;
				end`)
				);
			sql.push({ text: s.sql, params: [] });
		}
		sql.push({
			text: 'insert into bolt_schema (one, fingerprint, slice) values (true, $1, $2::jsonb) on conflict (one) do update set fingerprint = excluded.fingerprint, slice = excluded.slice, applied_at = now()',
			params: [p.to, JSON.stringify(p.slice)]
		});
		yield* db.transaction({ statements: sql, lock: { advisory: ['bolt:schema'] } }).pipe(
			Effect.catchTag('DbError', (error) =>
				Effect.gen(function* () {
					if (error.sqlstate === 'BS001') {
						const payload = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(Schema.Struct({ current: Schema.NullOr(Schema.String) }))
						)(error.message).pipe(
							Effect.mapError((cause) => BoltError.make('schema', 'decode', cause.message, cause))
						);
						return yield* Effect.fail(
							BoltError.make(
								'schemaMoved',
								'admission',
								`the database is at schema ${String(payload.current)}, the plan starts from ${String(p.from)}; plan again`
							)
						);
					}
					if (error.sqlstate === 'BS002') {
						const payload = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(
								Schema.Struct({ constraint: Schema.String, rows: Schema.Number })
							)
						)(error.message).pipe(
							Effect.mapError((cause) => BoltError.make('schema', 'decode', cause.message, cause))
						);
						return yield* Effect.fail(
							BoltError.make(
								'schemaInvalid',
								'commit',
								`${payload.constraint} refuses ${payload.rows} existing row${payload.rows === 1 ? '' : 's'}`,
								payload
							)
						);
					}
					return yield* Effect.fail(error);
				})
			)
		);
	}))();

const constraints = new WeakMap<EngineManifest, ReadonlyMap<string, ConstraintMeta>>();
/** Constraint name → its declaration, for the SQLSTATE map; once per manifest, which `bolt check` proved. */
export function constraintIndex(m: EngineManifest): ReadonlyMap<string, ConstraintMeta> {
	let c = constraints.get(m);
	if (c === undefined) constraints.set(m, (c = storeSync(storeConstraintIndex(schemaSlice(m)))));
	return c;
}
