// Schema projection and planning. Hosts and tests execute verified SQL files through apply_migrations.
import { Effect, Schema } from 'effect';
import {
	canonical,
	constraint_index as storeConstraintIndex,
	destructive_steps as storeDestructiveSteps,
	plan as storePlan,
	sha256_hex,
	schema_snapshot,
	TableSpec,
	type SchemaSnapshot,
	type ConstraintMeta,
	type Plan,
	type SchemaObject
} from '@norbital-ai/store';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { EngineManifest } from '../manifest.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { tables_of } from '../../protocol/catalog.ts';
import { message_text } from '../../decl/errors/refusal.ts';
import type { RuleMeta } from './refusal.ts';
import { engineObjects } from './engine.ts';
import { audit_triggers } from './audit.ts';
import { history_schema_objects } from './history.ts';

/** What the database depends on: the fingerprint is over exactly this. */
export const SchemaSliceSchema = Schema.Struct({
	tables: Schema.Record(Schema.String, TableSpec),
	tz: Schema.String,
	currency: Schema.NullOr(Schema.String)
});
export type SchemaSlice = typeof SchemaSliceSchema.Type;
type AppliedSchemaSlice = SchemaSnapshot;

/**
 * What the database holds for a workspace: its models and relationships beside the built-in layer's (`src/system`) as
 * the store's tables. Runtime account rows do not belong to the schema fingerprint.
 */
export function schema_slice(m: EngineManifest): SchemaSlice {
	return {
		tables: tables_of(m.models, m.relationships),
		currency: m.workspace.currency ?? null,
		tz: m.workspace.tz
	};
}
/** The schema hash activation compares: SHA-256 of the canonical schema slice. */
export const fingerprint = (s: SchemaSlice): string => sha256_hex(canonical(s));

/** Private tables/functions and schema-derived history/audit objects; runtime account rows are untouched. */
export const engineBeside = (s: SchemaSlice): Effect.Effect<readonly SchemaObject[], BoltError> =>
	Effect.map(history_schema_objects(s.tables, s.currency), (history) => [
		...engineObjects(),
		...history,
		...audit_triggers(s.tables)
	]);

const AppliedEnvelope = Schema.Struct({
	tables: Schema.Record(Schema.String, Schema.Json),
	tz: Schema.String,
	currency: Schema.NullOr(Schema.String)
});

/** Verify preserved metadata before any current-schema decoder can strip or rename its fields. */
export const readAppliedRecord = Effect.fn('Bolt.readAppliedRecord')(function* (db: TenantDbShape) {
	const [present] = yield* db.read([
		{ text: `select to_regclass('bolt_schema') is not null as present`, params: [] }
	]);
	if (present?.rows[0]?.present !== true) return null;
	const [rows] = yield* db.read([{ text: 'select fingerprint, slice from bolt_schema', params: [] }]);
	const values = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
		fingerprint: Schema.String,
		slice: Schema.Record(Schema.String, Schema.Json)
	})))(rows?.rows ?? []).pipe(Effect.mapError((error) => BoltError.make('schema', 'decode', error.message, error)));
	if (values.length === 0) return null;
	const [held] = values;
	if (held === undefined || values.length !== 1)
		return yield* BoltError.make('schema', 'decode', 'the applied schema must have exactly one row');
	if (sha256_hex(canonical(held.slice)) !== held.fingerprint)
		return yield* BoltError.make('schema', 'decode', 'the original applied schema does not match its recorded fingerprint');
	return { fingerprint: held.fingerprint, original: held.slice };
});
export type AppliedSchemaRecord = NonNullable<Effect.Success<ReturnType<typeof readAppliedRecord>>>;

/** Current applied schema, with its original verified identity; a slice the snapshot schema refuses fails to decode. */
export const read_applied = Effect.fn('Bolt.read_applied')(function* (db: TenantDbShape) {
	const held = yield* readAppliedRecord(db);
	if (held === null) return null;
	const envelope = yield* Schema.decodeUnknownEffect(AppliedEnvelope, { onExcessProperty: 'error' })(held.original).pipe(
		Effect.mapError((error) => BoltError.make('schema', 'decode', error.message, error))
	);
	const projected = yield* schema_snapshot({ tables: envelope.tables, tz: envelope.tz, currency: envelope.currency }).pipe(
		Effect.mapError(from_store)
	);
	return {
		...projected, ...held
	} satisfies AppliedSchemaSlice;
});
/** The store's plan from `applied` to the manifest's (or a given) slice, the engine's objects beside both. */
export const plan = (
	applied: AppliedSchemaSlice | null,
	next: EngineManifest | SchemaSlice
): Effect.Effect<Plan & { readonly slice: SchemaSlice }, BoltError> => {
	const slice = 'workspace' in next ? schema_slice(next) : next;
	return storePlan(
		applied?.schema ?? null,
		slice,
		engineBeside
	).pipe(
		Effect.map((p) => ({
			...p,
			from: applied?.fingerprint ?? null,
			to: fingerprint(slice),
			slice
		})),
		Effect.catchTag('StoreError', (e) => Effect.fail(from_store(e)))
	);
};
/** The same schema diff's destructive ids, without rendering fixed, never-dropped search function bodies. */
export const destructiveSteps = (
	applied: SchemaSlice | null,
	next: EngineManifest | SchemaSlice
): Effect.Effect<readonly string[], BoltError> => {
	const slice = 'workspace' in next ? schema_slice(next) : next;
	return storeDestructiveSteps(
		applied,
		slice,
		engineBeside
	).pipe(Effect.catchTag('StoreError', (e) => Effect.fail(from_store(e))));
};
const constraints = new WeakMap<EngineManifest, ReadonlyMap<string, RuleMeta>>();
// by slice too: every load of one workspace is another manifest object over the same schema
const bySlice = new Map<string, ReadonlyMap<string, ConstraintMeta>>();
/**
 * Constraint name → its declaration, for the SQLSTATE map; once per schema, which `bolt check` proved. A rule's authored
 * message (`messages`) is no schema: it joins per manifest, as its catalogue key and the workspace catalogue's text.
 */
export const constraintIndex = Effect.fnUntraced(function* (
	m: EngineManifest
): Effect.fn.Return<ReadonlyMap<string, RuleMeta>, BoltError> {
	const known = constraints.get(m);
	if (known !== undefined) return known;
	const slice = schema_slice(m),
		key = JSON.stringify(slice);
	let c = bySlice.get(key);
	if (c === undefined) {
		c = yield* storeConstraintIndex(slice).pipe(Effect.mapError(from_store));
		// ponytail: oldest-first bound; a host serving more live schemas than this recomputes per manifest
		for (const old of bySlice.keys()) if (bySlice.size >= 64) bySlice.delete(old);
		bySlice.set(key, c);
	}
	const keyed = new Map<string, RuleMeta>([...c].map(([name, meta]) => {
		const message = meta.rule === undefined ? undefined : m.models[meta.model]?.messages?.[meta.rule];
		return [name, message === undefined ? meta : { ...meta, key: message, message: message_text(m.messages, message) }] as const;
	}));
	constraints.set(m, keyed);
	return keyed;
});
