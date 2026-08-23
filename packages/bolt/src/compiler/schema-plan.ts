import { collectionSearchTrigramIndexName } from '@norbital-ai/std/collection';
import type { ModelExclusion, ModelIndex } from '../authoring/models-schema.js';
import {
	compileModel,
	describeModel,
	searchableColumns
} from '../authoring/model-introspection.js';
import { INTERNAL_SYSTEM_MODELS, SYSTEM_MODELS } from '../authoring/system-models.js';
import { defineSystemRowModel } from '../authoring/system-row-model.js';
import type {
	CollectionDefinition,
	FieldDefinition,
	WorkspaceDefinition
} from '../authoring/workspace-schema.js';
import { collection } from '../authoring/workspace-schema.js';
import {
	IDENTITY_COLLECTIONS,
	withSystemCollections
} from '../runtime/schema/system-collections.js';

type SchemaStep = Readonly<{
	readonly id: string;
	readonly sql: string;
}>;

/** Fingerprints the exact ordered DDL a database or replica will apply. */
export const fingerprintSchemaSteps = (steps: ReadonlyArray<SchemaStep>): string => {
	const source = JSON.stringify(steps);
	let hash = 2_166_136_261;
	for (let index = 0; index < source.length; index += 1) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

export type SchemaPlan = Readonly<{
	readonly fingerprint: string;
	readonly steps: ReadonlyArray<SchemaStep>;
}>;

/** Quotes a PostgreSQL identifier. Shared so plan DDL and migration DDL cannot quote differently. */
const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/**
 * The tables the plan's steps create, read back out of the DDL this module rendered.
 *
 * It lives here rather than in `verify` because this module is the only writer of that DDL: every
 * table step below is `create table if not exists <name>`, bare for the `bolt_*` tables and quoted
 * for collections, so reading the name back is reading this module's own output rather than parsing
 * arbitrary SQL. Steps that create extensions, functions or indexes match nothing and are skipped.
 *
 * `verify` needs this because it only ever compared authored collections. A `bolt_*` table the plan
 * declares could therefore be missing while `migrate` still reported success — which is exactly how
 * `agents.*` answered `relation "chat_session" does not exist` against a database whose
 * migration had just answered `migrated: true`. A plan step that did not take effect is a failed
 * migration, and nothing was asking.
 */
export const planTableNames = (plan: SchemaPlan): ReadonlyArray<string> => {
	const pattern = /create table if not exists\s+(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))/giu;
	return [
		...new Set(
			plan.steps.flatMap((step) =>
				[...step.sql.matchAll(pattern)].flatMap((match) => {
					const quoted = match[1];
					const bare = match[2];
					if (quoted !== undefined) return [quoted.replaceAll('""', '"')];
					return bare === undefined ? [] : [bare];
				})
			)
		)
	].toSorted((left, right) => left.localeCompare(right));
};

/** Owns PostgreSQL type mapping, identifier quoting, and deterministic plan fingerprints. */
const SchemaPlanValues = {
	/**
	 * The SQL type a column is created as: what its builder declares, or the scalar mapping below
	 * when the field was hand-written rather than recovered from one.
	 *
	 * The mapping is a fallback and not the answer, because a scalar is a lossy summary of a column.
	 * `number` covers `integer`, `numeric` and `double precision`, and rendering all three as
	 * `double precision` put payroll money into binary floating point while the migration lineage
	 * created the same column `numeric` from the same declaration. It survived because `verify`
	 * compares column *names*, and both sides did have a column called `amount`.
	 *
	 * The fallback still serves the runtime-owned collections in `system-collections.ts` and every
	 * definition assembled in tests, which are `field.*` calls with no builder behind them.
	 */
	columnType: (field: FieldDefinition): string =>
		field.sqlType ?? SchemaPlanValues.sqlType(field.type),
	sqlType: (type: string): string => {
		switch (type) {
			// The same type `id` is, because that is what these columns reference. Planning a
			// foreign key as `text` left the plan unable to render the join its own where compiler
			// emits, so every relation filter against a Bolt-provisioned database failed on
			// `operator does not exist: text = uuid`.
			case 'uuid':
				return 'uuid';
			case 'number':
				return 'double precision';
			case 'boolean':
				return 'boolean';
			case 'datetime':
				return 'timestamptz';
			case 'json':
				return 'jsonb';
			default:
				return 'text';
		}
	},
	quoteIdentifier
};

const systemRowFields = describeModel(defineSystemRowModel());
const systemTableNames: ReadonlySet<string> = new Set(Object.keys(SYSTEM_MODELS));
const internalSystemTables: ReadonlyArray<
	CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
> = Object.entries(INTERNAL_SYSTEM_MODELS).map(([name, declaration]) =>
	compileModel(collection({ name, fields: {} }), declaration)
);

const renderColumn = (name: string, field: FieldDefinition): string => {
	const column = `${SchemaPlanValues.quoteIdentifier(name)} ${SchemaPlanValues.columnType(field)}`;
	if (field.generated !== undefined)
		return `${column} generated always as (${field.generated}) stored`;
	if (field.primaryKey)
		return `${column} primary key${field.sqlDefault === undefined ? '' : ` default ${field.sqlDefault}`}`;
	const defaulted =
		field.sqlDefault === undefined ? column : `${column} default ${field.sqlDefault}`;
	return `${defaulted}${field.required ? ' not null' : ''}${field.unique ? ' unique' : ''}`;
};

const SYSTEM_COLUMNS = Object.entries(systemRowFields)
	.map(([name, field]) => renderColumn(name, field))
	.join(', ');

/**
 * Dollar-quote tag for the guarded EXCLUDE blocks. Nothing interpolated into one may contain it, or
 * the block would terminate early and the rest of the constraint would be parsed as statements.
 */
const EXCLUSION_TAG = '$bolt_exclusion$';

/** Identifiers Bolt is willing to inline into generated DDL unquoted, inside a dollar-quoted body. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The name of the index a column authored `indexed: true` is served by.
 *
 * Exported because the migration generator creates the same index as a Drizzle entity and has to
 * name it identically: a workspace that got the index from its lineage must meet a
 * `create index if not exists` that is already satisfied, rather than a second index over the same
 * column under a different name. This is the same arrangement `collectionSearchTrigramIndexName`
 * gives the trigram indexes, kept here because the declared index is Bolt's own naming and nothing
 * outside the compiler needs to say it.
 */
export const collectionIndexName = (collectionName: string, columnName: string): string =>
	`${collectionName}_${columnName}_idx`;

/**
 * A collection's declared index steps, one per column authored `indexed: true`.
 *
 * `FieldDefinition.indexed` was read by nothing that emits DDL, so `field.string({ indexed: true })`
 * was accepted and dropped — including on Bolt's own `approval_request` and `requestor`, whose
 * `collection_name`, `record_id` and `status` lookups ran as sequential scans over every approval
 * the workspace had ever raised.
 *
 * `if not exists` rather than a bare `create index` because the plan runs in full on every provision
 * and the migration lineage creates the same index under the same name; whichever runs first
 * satisfies the other, and a second run is a no-op instead of a duplicate-name failure.
 */
const declaredIndexSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> =>
	Object.entries(collection.fields)
		// Primary-key and unique constraints already own an index. Emitting another named btree over
		// the same column adds write cost and disk without serving a different query.
		.filter(([, field]) => field.indexed && field.primaryKey !== true && field.unique !== true)
		.map(([column, field]) => ({ column, unique: field.unique === true }))
		.toSorted((left, right) => left.column.localeCompare(right.column))
		.map(({ column, unique }) => ({
			// Sorts after `collection:<name>` (its table), so the column exists by the time this runs.
			id: `collection:${collection.name}:index:${column}`,
			sql: `create ${unique ? 'unique ' : ''}index if not exists ${quoteIdentifier(collectionIndexName(collection.name, column))} on ${quoteIdentifier(collection.name)} (${quoteIdentifier(column)})`
		}));

const modelIndexSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> =>
	(collection.indexes ?? []).map((declaration: ModelIndex) => {
		if (declaration.columns.length === 0)
			throw new TypeError(`Collection ${collection.name} declares an index with no columns.`);
		const columnNames = declaration.columns.map((column) =>
			typeof column === 'string' ? column : column.expr
		);
		const derivedName = columnNames.join('_').replaceAll(/[^a-zA-Z0-9_]/g, '_');
		const name =
			declaration.name ?? collectionIndexName(collection.name, derivedName || 'expression');
		const columns = declaration.columns
			.map((column) => {
				if (typeof column !== 'string') return `(${column.expr})`;
				const opclass = declaration.opclass?.[column];
				return `${quoteIdentifier(column)}${opclass === undefined ? '' : ` ${opclass}`}`;
			})
			.join(', ');
		return {
			id: `collection:${collection.name}:index:${name}`,
			sql: `create ${declaration.unique === true ? 'unique ' : ''}index if not exists ${quoteIdentifier(name)} on ${quoteIdentifier(collection.name)}${declaration.method === undefined ? '' : ` using ${declaration.method}`} (${columns})${declaration.where === undefined ? '' : ` where ${declaration.where}`}`
		};
	});

/**
 * A collection's trigram index steps, one per column the author opted into free-text search.
 *
 * Free-text search compiles to `ilike '%term%'`, which no btree index can answer, so every search was
 * a sequential scan over the whole collection. `gin_trgm_ops` indexes character trigrams rather than
 * words, so one index serves substring search in any script without a dictionary or a tokenizer.
 *
 * The name comes from `@norbital-ai/std/collection` rather than being formatted here: the migration
 * generator creates the same index as a Drizzle entity under that same name, so a workspace that got
 * the index from its lineage meets a `create index if not exists` that is already satisfied instead of
 * a second index over the same column.
 */
const searchIndexSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> =>
	searchableColumns(collection.fields).map((column) => ({
		// Sorts after `collection:<name>` (its table) and after every `bolt:` id, so `pg_trgm` is
		// installed and the column exists by the time this runs.
		id: `collection:${collection.name}:search:${column}`,
		sql: `create index if not exists ${quoteIdentifier(collectionSearchTrigramIndexName(collection.name, column))} on ${quoteIdentifier(collection.name)} using gin (${quoteIdentifier(column)} gin_trgm_ops)`
	}));

/**
 * One authored EXCLUDE constraint, guarded so re-running the plan is a no-op.
 *
 * Postgres has no `add constraint if not exists`, and the plan runs in full inside one transaction on
 * every provision — so a drop/add pair would rebuild and revalidate a GiST index over the whole table,
 * holding an ACCESS EXCLUSIVE lock, every single time. The guard reads `pg_constraint` instead.
 *
 * `gist` is not a choice: these mix equality members with range `&&`, which only gist can index, and
 * only with `btree_gist` installed for the equality halves — hence the `bolt:extension-btree-gist`
 * step this sorts after.
 */
const exclusionStep = (collectionName: string, exclusion: ModelExclusion): SchemaStep => {
	// Both are inlined as string literals inside the guard's `pg_constraint` lookup, where quoting an
	// identifier would make it a column reference rather than a name.
	if (!SAFE_IDENTIFIER.test(collectionName)) {
		throw new TypeError(
			`Collection "${collectionName}" declares an exclusion but is not a lower_snake_case identifier.`
		);
	}
	if (!SAFE_IDENTIFIER.test(exclusion.name)) {
		throw new TypeError(
			`Exclusion constraint name "${exclusion.name}" must be a lower_snake_case identifier.`
		);
	}
	if (exclusion.elements.length === 0) {
		throw new TypeError(`Exclusion ${exclusion.name} must declare at least one element.`);
	}
	const elements = exclusion.elements.map(({ expr, with: operator }) => {
		if (expr.includes(EXCLUSION_TAG) || operator.includes(EXCLUSION_TAG)) {
			throw new TypeError(`Exclusion ${exclusion.name} may not contain "${EXCLUSION_TAG}".`);
		}
		return `${expr} with ${operator}`;
	});
	return {
		id: `collection:${collectionName}:exclusion:${exclusion.name}`,
		sql: `do ${EXCLUSION_TAG} begin if not exists (select 1 from pg_constraint where conname = '${exclusion.name}' and conrelid = '${collectionName}'::regclass) then alter table ${quoteIdentifier(collectionName)} add constraint ${quoteIdentifier(exclusion.name)} exclude using gist (${elements.join(', ')}); end if; end ${EXCLUSION_TAG}`
	};
};

/** Owns build schema plan behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
export const buildSchemaPlan = (authored: WorkspaceDefinition): SchemaPlan => {
	// Runtime-owned collections are planned exactly like authored ones: authored queries read them,
	// so they need the same row columns rather than a private hand-written table shape.
	const workspace = withSystemCollections(authored);
	// Step ids are sorted, and every `bolt:` id sorts before every `collection:` id, so these
	// projections exist before the generated columns that call them are created.
	const foundation: ReadonlyArray<SchemaStep> = [
		// `bolt:extension-*` sorts before every function, table and index that needs one.
		//
		// These were absent entirely, which cost more than it looked: `ilike '%term%'` is unanswerable
		// by btree, so free-text search scanned every row, and the effective-dating EXCLUDE constraints
		// could not be created — leaving the database willing to hold overlapping temporal rows the
		// application assumes are impossible.
		//
		// No `pgcrypto`: `gen_random_uuid()`, the default on every primary key, has been core since
		// Postgres 13. Requesting the extension only fails on a build that does not ship it.
		{ id: 'bolt:extension-btree-gist', sql: 'create extension if not exists btree_gist' },
		{ id: 'bolt:extension-pg-trgm', sql: 'create extension if not exists pg_trgm' },
		// `vector`, for the embedding columns two templates declare. Unconditional, like the two above:
		// the plan runs before the lineage that creates the columns, so deciding from the declarations
		// would mean deciding from a workspace this step cannot see — and a tenant provisioned before a
		// template gained its first embedding column would have no step to add it later. A workspace
		// that never embeds anything pays for an unused extension; one that does, without this, fails
		// its very first migration on `type "vector" does not exist`.
		{ id: 'bolt:extension-vector', sql: 'create extension if not exists vector' },
		{
			// Declarative reconciliation locks a graph optimistically, then verifies immediately before
			// commit that no row changed beneath the snapshot it prepared. PostgreSQL has no scalar
			// assertion expression, and deliberately crashing arithmetic reports a non-retryable data
			// error. This function gives every generated database one exact guard: false (and NULL, which
			// is not proof) raises serialization_failure so the existing retry boundary can safely rerun
			// the whole atomic mutation.
			id: 'bolt:function-assert',
			sql: "create or replace function bolt_assert(ok boolean, message text) returns void language plpgsql volatile parallel unsafe as $bolt_assert$ begin if ok is not true then raise exception '%', message using errcode = '40001'; end if; end $bolt_assert$"
		},
		{
			// A STORED generated column refuses a STABLE expression, and `text::date` is only STABLE
			// because it reads DateStyle. Authored values are canonical ISO dates, whose parse does not,
			// so this wrapper is honestly immutable. Empty or absent projects NULL, which is what a
			// union arm that does not carry the field needs.
			id: 'bolt:function-date',
			sql: "create or replace function bolt_date(value text) returns date language sql immutable parallel safe as $bolt_date$ select nullif(value, '')::date $bolt_date$"
		},
		{
			// Half-open [start, end): adjacent periods touch without overlapping, and a missing bound
			// is unbounded.
			id: 'bolt:function-daterange',
			sql: "create or replace function bolt_daterange(payload jsonb) returns daterange language sql immutable parallel safe as $bolt_daterange$ select daterange(nullif(payload->>'start', '')::date, nullif(payload->>'end', '')::date, '[)') $bolt_daterange$"
		}
	];
	/**
	 * Collection DDL the plan still owns, which is now only what Drizzle cannot express.
	 *
	 * Two renderings of the same table used to exist — this module's `create table if not exists` and
	 * the lineage's `CREATE TABLE` — and they were not obliged to agree. They didn't: the scalar
	 * fallback below renders `number` as `double precision`, so a `numeric` money column created from
	 * the plan held binary floating point while the same declaration created from the lineage held
	 * `numeric`. `verify` compares column *names* and both sides had an `amount`, so nothing caught it.
	 *
	 * The lineage is now the only writer of workspace collection tables, their columns, and their
	 * indexes. What stays here is what has no Drizzle entity to be rendered from:
	 *
	 *   - EXCLUDE constraints (`CollectionDefinition.exclusions`), which drizzle-kit cannot emit.
	 *   - Bolt's own system collections, which belong to no workspace and appear in no workspace
	 *     lineage, so only the plan can create them.
	 */
	const collections = [...workspace.collections, ...internalSystemTables]
		.flatMap((collection) => {
			const exclusions = (collection.exclusions ?? []).map((exclusion) =>
				exclusionStep(collection.name, exclusion)
			);
			if (!systemTableNames.has(collection.name)) return exclusions;
			const fields = Object.entries(collection.fields)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, field]) => renderColumn(name, field));
			const sql = `create table if not exists ${SchemaPlanValues.quoteIdentifier(collection.name)} (${SYSTEM_COLUMNS}${fields.length === 0 ? '' : `, ${fields.join(', ')}`})`;
			return [
				{ id: `collection:${collection.name}`, sql },
				...declaredIndexSteps(collection),
				...modelIndexSteps(collection),
				...searchIndexSteps(collection),
				...(collection.name === 'bolt_sync_horizon'
					? [
							{
								id: 'collection:bolt_sync_horizon:seed',
								sql: 'insert into bolt_sync_horizon (singleton) values (true) on conflict (singleton) do nothing'
							}
						]
					: []),
				...exclusions
			];
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const steps = [...foundation, ...collections].toSorted((left, right) =>
		left.id.localeCompare(right.id)
	);
	return { fingerprint: fingerprintSchemaSteps(steps), steps };
};

/**
 * The steps a host applies before anything can authenticate.
 *
 * A freshly provisioned database is empty, and `schema.migrate` — the command that would fill it —
 * authenticates through a session row like every other command. So a host has to create identity's
 * tables before it can migrate, and this is what it applies: the same steps the plan would emit for
 * those collections, generated from the same declaration, rather than a copy of the DDL kept
 * somewhere a host could let drift. `schema.migrate` remains the authority and re-applies them.
 */
/** The identity collections' names, so the filter below reads the declaration and not a convention. */
const IDENTITY_COLLECTION_NAMES: ReadonlyArray<string> = IDENTITY_COLLECTIONS.map(
	({ name }) => name
);

export const identitySchemaSteps = (): ReadonlyArray<SchemaStep> =>
	buildSchemaPlan({
		name: 'identity',
		version: '0.0.1',
		collections: IDENTITY_COLLECTIONS,
		customTypes: {},
		apps: [],
		policies: [],
		relations: [],
		prompt: '',
		tools: [],
		skills: [],
		automations: [],
		envoys: [],
		integrations: [],
		requiredFacilities: []
	}).steps.filter(
		(step) =>
			!step.id.includes(':search:') &&
			// Derived from the declaration rather than from a naming convention. `team` and
			// `auth_config` are just as necessary to authentication as Better Auth's four models, so a
			// prefix or allowlist maintained beside the declarations could silently leave a new host
			// unable to authenticate anybody.
			IDENTITY_COLLECTION_NAMES.some(
				(name) => step.id === `collection:${name}` || step.id.startsWith(`collection:${name}:`)
			)
	);
