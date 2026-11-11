// Schema projection and planning. Hosts and tests execute verified SQL files through applyMigrations.
import { Effect, Schema } from 'effect';
import {
	canonical,
	constraintIndex as storeConstraintIndex,
	destructiveSteps as storeDestructiveSteps,
	plan as storePlan,
	sha256Hex,
	TableSpec,
	type ConstraintMeta,
	type Plan,
	type SchemaObject
} from '@norbital-ai/store';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { EngineManifest } from '../manifest.ts';
import { BoltError, fromStore, storeSync } from '../../protocol/errors.ts';
import { tablesOf } from '../../protocol/catalog.ts';
import { configurationDefaults } from '../../decl/runtime/integration.ts';
import { definitionOf } from '../integrations/instances.ts';
import { engineObjects } from './engine.ts';
import { auditTriggers } from './audit.ts';
import { historySchemaObjects } from './history.ts';

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
/**
 * A connection is its named instance: inserted once with its default configuration (runtime edits stay), as
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
				configuration: c.configuration
			}))
		)
	);
	return [
		{
			id: 'source:connections',
			rank: 'backfill',
			table: 'sys_integration',
			deps: ['id', 'integration', 'name', 'named', 'configuration'],
			drop: null,
			create: [
				`delete from ${q('sys_integration')} where named and (id, integration) not in (select id, integration from jsonb_to_recordset(${slots}::jsonb) as s(id text, integration text))`,
				`insert into ${q('sys_integration')} (id, integration, name, named, configuration) select id, integration, id, true, configuration
					from jsonb_to_recordset(${slots}::jsonb) as s(id text, integration text, configuration jsonb) on conflict (id) do nothing`
			]
		}
	];
}
/** The engine's own objects beside a slice: its connections, then its private tables and functions (they come last). */
export const engineBeside = (s: SchemaSlice): readonly SchemaObject[] => [
	...connectionsObject(s),
	...engineObjects(),
	...historySchemaObjects(s.tables, s.currency),
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
const constraints = new WeakMap<EngineManifest, ReadonlyMap<string, ConstraintMeta>>();
// by slice too: every load of one workspace is another manifest object over the same schema
const bySlice = new Map<string, ReadonlyMap<string, ConstraintMeta>>();
/** Constraint name → its declaration, for the SQLSTATE map; once per schema, which `bolt check` proved. */
export function constraintIndex(m: EngineManifest): ReadonlyMap<string, ConstraintMeta> {
	const known = constraints.get(m);
	if (known !== undefined) return known;
	const slice = schemaSlice(m),
		key = JSON.stringify(slice);
	let c = bySlice.get(key);
	if (c === undefined) {
		c = storeSync(storeConstraintIndex(slice));
		// ponytail: oldest-first bound; a host serving more live schemas than this recomputes per manifest
		for (const old of bySlice.keys()) if (bySlice.size >= 64) bySlice.delete(old);
		bySlice.set(key, c);
	}
	constraints.set(m, c);
	return c;
}
