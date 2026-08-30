import { canonicalSchemaStepEncoding, digestSchemaSteps } from '@norbital-ai/std/reckon/hash';
export { canonicalSchemaStepEncoding, digestSchemaSteps };
import type { ModelExclusion, ModelIndex } from '../authoring/models-schema.js';
import {
	compileModel,
	describeModel,
	EMBEDDED_AT_COLUMN,
	RECORD_EMBEDDING_COLUMN,
	RECORD_EMBEDDING_FINGERPRINT_COLUMN,
	SEARCH_DOCUMENT_COLUMN,
	searchDocumentExpression,
	searchTextExpression,
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
import { approvalRefusal } from './approval-checks.js';
import { withSystemCollections } from '../runtime/schema/system-collections.js';

type SchemaStep = Readonly<{
	readonly id: string;
	/** Compiler-owned DDL, or the explicitly named bootstrap seed below; never application CRUD. */
	readonly sql: string;
}>;

/** Fingerprints the exact ordered DDL the database will apply. */
export const fingerprintSchemaSteps = (steps: ReadonlyArray<SchemaStep>): string =>
	digestSchemaSteps(steps);

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
			case 'instant':
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
 * column under a different name. This is the same arrangement the shared collection search index
 * naming helpers give the lexical indexes, kept here because the declared index is Bolt's own
 * naming and nothing outside the compiler needs to say it.
 */
export const collectionIndexName = (collectionName: string, columnName: string): string =>
	`${collectionName}_${columnName}_idx`;

const boundedCollectionIndexName = (fullName: string, suffix: string): string => {
	if (fullName.length <= 63) return fullName;
	let hash = 2166136261;
	for (const character of fullName) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	const hashedSuffix = `_${(hash >>> 0).toString(36)}_${suffix}`;
	return `${fullName.slice(0, 63 - hashedSuffix.length)}${hashedSuffix}`;
};

/** Stable compiler-owned name for the GIN over a collection's stored lexical document. */
export const collectionSearchDocumentIndexName = (collectionName: string): string =>
	boundedCollectionIndexName(`${collectionName}_search_document_gin_idx`, 'search_gin_idx');

/** Stable compiler-owned name for the GIN over a collection's concatenated searchable text. */
export const collectionSearchTextTrigramIndexName = (collectionName: string): string =>
	boundedCollectionIndexName(`${collectionName}_search_text_trgm_idx`, 'trgm_idx');

/** One ongoing request may govern a collection record at a time, including concurrent creates. */
export const APPROVAL_REQUEST_ONGOING_INDEX_NAME =
	'approval_request_collection_record_ongoing_uidx';

const approvalRequestOngoingIndexSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> =>
	collection.name !== 'approval_request'
		? []
		: [
				{
					id: `collection:${collection.name}:index:${APPROVAL_REQUEST_ONGOING_INDEX_NAME}`,
					sql: `create unique index if not exists ${quoteIdentifier(APPROVAL_REQUEST_ONGOING_INDEX_NAME)} on ${quoteIdentifier(collection.name)} (${quoteIdentifier('collection_name')}, ${quoteIdentifier('record_id')}) where ${quoteIdentifier('status')} = 'ONGOING'`
				}
			];

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
 * A collection's generated lexical document and its two supporting indexes.
 *
 * `search_document` uses the immutable `to_tsvector(regconfig, text)` overload and is stored, so
 * reads never rebuild it. Its GIN serves token/prefix matches; a second GIN over the same concatenated
 * text with `gin_trgm_ops` serves fuzzy and language-agnostic matching. The field list comes solely
 * from the model's `search: true` flags and is sorted once by `searchableColumns`.
 */
const searchIndexSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> => {
	const columns = collection.search?.fields ?? searchableColumns(collection.fields);
	if (columns.length === 0) return [];
	const table = quoteIdentifier(collection.name);
	const document = quoteIdentifier(SEARCH_DOCUMENT_COLUMN);
	return [
		{
			id: `collection:${collection.name}:search:1-document-gin`,
			sql: `create index if not exists ${quoteIdentifier(collectionSearchDocumentIndexName(collection.name))} on ${table} using gin (${document})`
		},
		{
			id: `collection:${collection.name}:search:2-trigram-gin`,
			sql: `create index if not exists ${quoteIdentifier(collectionSearchTextTrigramIndexName(collection.name))} on ${table} using gin ((${searchTextExpression(columns)}) gin_trgm_ops)`
		}
	];
};

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
		// repository-health:allow SQL1 -- guarded EXCLUDE-constraint DDL; the catalog read makes
		// PostgreSQL's missing `ADD CONSTRAINT IF NOT EXISTS` behavior idempotent during provisioning.
		sql: `do ${EXCLUSION_TAG} begin if not exists (select 1 from pg_constraint where conname = '${exclusion.name}' and conrelid = '${collectionName}'::regclass) then alter table ${quoteIdentifier(collectionName)} add constraint ${quoteIdentifier(exclusion.name)} exclude using gist (${elements.join(', ')}); end if; end ${EXCLUSION_TAG}`
	};
};

/**
 * Installs the database-owned sync capture for one collection after its table exists.
 *
 * The RFC's precondition for the sync engine is that embedding write-back never enters the
 * changelog: `embedRecords` rewrites each embedding-declaring row's derived settle columns —
 * `record_embedding`, `record_embedding_fingerprint`, `embedded_at` — and none of that is a change
 * a query is interested in. So an embedding collection's UPDATE capture fires only when the row
 * moved *outside* the derived columns: the WHEN witnesses NEW ≈ OLD on exactly those columns, and
 * any ordinary write — which advances `row_version`/`updated_at` and touches authored fields —
 * still captures, while a refresh that sets only derived columns is silent. A trigger WHEN may
 * reference OLD and NEW only, and only on an UPDATE trigger, which is why capture is split here:
 * inserts and deletes always capture; only the update half carries the witness.
 *
 * `search_document` stays out of the witness on purpose: it is a stored generated column no
 * statement can write, so it can only differ when an authored field did — and that update must
 * capture. Collections without a declared embedding keep the single three-op trigger, because
 * their tables have none of the witness columns and a WHEN referencing them would fail to create.
 */
const syncTriggerSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> => {
	const table = quoteIdentifier(collection.name);
	if (collection.embedding === undefined) {
		return [
			{
				id: `sync-trigger:${collection.name}:1-drop`,
				sql: `drop trigger if exists bolt_sync_capture on ${table}`
			},
			{
				id: `sync-trigger:${collection.name}:2-create`,
				sql: `create trigger bolt_sync_capture after insert or update or delete on ${table} for each row execute function bolt_capture_sync_change()`
			}
		];
	}
	// NEW-≈-OLD on the runtime's derived settle columns: false only when the refresh itself wrote
	// them, which is exactly the write that must not be captured. Everything else about the row
	// changing — authored fields, row_version, updated_at — fires the trigger as before.
	const derivedUnchanged = [
		RECORD_EMBEDDING_COLUMN,
		RECORD_EMBEDDING_FINGERPRINT_COLUMN,
		EMBEDDED_AT_COLUMN
	]
		.map(
			(column) =>
				`new.${quoteIdentifier(column)} is not distinct from old.${quoteIdentifier(column)}`
		)
		.join(' and ');
	return [
		{
			id: `sync-trigger:${collection.name}:1-drop`,
			sql: `drop trigger if exists bolt_sync_capture on ${table}`
		},
		{
			id: `sync-trigger:${collection.name}:2-create`,
			sql: `create trigger bolt_sync_capture after insert or delete on ${table} for each row execute function bolt_capture_sync_change()`
		},
		{
			id: `sync-trigger:${collection.name}:2-update-drop`,
			sql: `drop trigger if exists bolt_sync_capture_update on ${table}`
		},
		{
			id: `sync-trigger:${collection.name}:3-update-create`,
			sql: `create trigger bolt_sync_capture_update after update on ${table} for each row when (${derivedUnchanged}) execute function bolt_capture_sync_change()`
		}
	];
};

/** Owns build schema plan behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
export const buildSchemaPlan = (authored: WorkspaceDefinition): SchemaPlan => {
	const authorityRefusal = approvalRefusal(authored);
	if (authorityRefusal !== undefined) throw new TypeError(authorityRefusal);
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
			// Day semantics live in the application value, but every projected column is still an
			// instant. Canonical ISO days are anchored at UTC midnight so generated columns never fall
			// back to PostgreSQL `date`, and the explicit zone keeps the result independent of the
			// database session. Empty or absent projects NULL for union arms without the value.
			id: 'bolt:function-instant',
			sql: "create or replace function bolt_instant(value text) returns timestamptz language sql immutable parallel safe as $bolt_instant$ select nullif(value, '')::date::timestamp at time zone 'UTC' $bolt_instant$"
		},
		{
			// Half-open [start, end): adjacent periods touch without overlapping, and a missing bound
			// is unbounded.
			id: 'bolt:function-daterange',
			sql: "create or replace function bolt_daterange(payload jsonb) returns daterange language sql immutable parallel safe as $bolt_daterange$ select daterange(nullif(payload->>'start', '')::date, nullif(payload->>'end', '')::date, '[)') $bolt_daterange$"
		},
		{
			// The trigger is the only writer of the outbox, which is the ordered per-commit changelog:
			// one row per sync-visible write carrying the collection and the sequence that orders it, with
			// the write's xid stamped for commit visibility. Consumers
			// read which collections moved between two sequences; the row itself (and the write's before/
			// after state) is the transaction's business, not the changelog's.
			//
			// Derived settle state never reaches here: an embedding collection's update trigger carries
			// a WHEN that fires only when the row moved outside `record_embedding`,
			// `record_embedding_fingerprint` and `embedded_at`, so `embedRecords`' refresh — a write the
			// sync engine's precondition excludes from the changelog — lands no outbox row per pass.
			// Deletes and inserts always capture; the split lives in the trigger steps, which can
			// reference both OLD and NEW, where a shared multi-event trigger's WHEN could not.
			id: 'bolt:function-sync-capture',
			sql: `create or replace function bolt_capture_sync_change() returns trigger language plpgsql as $bolt_sync_capture$ begin insert into bolt_sync_outbox (collection_name) values (TG_TABLE_NAME); if TG_OP = 'DELETE' then return OLD; end if; return NEW; end $bolt_sync_capture$`
		},
		{
			// Cron inputs are private because they may contain secrets. Their run records project into a
			// sync-visible collection in the same transaction; no claim, lease or retry state exists.
			id: 'bolt:function-automation-run-projection',
			sql: `create or replace function bolt_project_automation_run() returns trigger language plpgsql as $bolt_automation_run$ begin if TG_OP = 'DELETE' then if OLD.command like 'automations.%' then delete from automation_run where task_id = OLD.effect_id; end if; return OLD; end if; if NEW.command like 'automations.%' then insert into automation_run (task_id, name, status, progress, progress_sequence, progress_updated_at, result, error) values (NEW.effect_id, substring(NEW.command from length('automations.') + 1), NEW.status, NEW.progress, NEW.progress_sequence, NEW.progress_updated_at, NEW.result, NEW.error) on conflict (task_id) do update set name = excluded.name, status = excluded.status, progress = excluded.progress, progress_sequence = excluded.progress_sequence, progress_updated_at = excluded.progress_updated_at, result = excluded.result, error = excluded.error, updated_at = now(), row_version = automation_run.row_version + 1; end if; return NEW; end $bolt_automation_run$`
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
				.map(([name, field]) => ({ name, sql: renderColumn(name, field) }));
			const searchColumns = collection.search?.fields ?? searchableColumns(collection.fields);
			const searchDocument =
				searchColumns.length === 0
					? []
					: [
							`${quoteIdentifier(SEARCH_DOCUMENT_COLUMN)} tsvector generated always as (${searchDocumentExpression(searchColumns)}) stored`
						];
			const table = SchemaPlanValues.quoteIdentifier(collection.name);
			const declaredColumns = [...fields.map(({ sql }) => sql), ...searchDocument];
			const sql = `create table if not exists ${table} (${SYSTEM_COLUMNS}${declaredColumns.length === 0 ? '' : `, ${declaredColumns.join(', ')}`})`;
			return [
				{ id: `collection:${collection.name}`, sql },
				...declaredIndexSteps(collection),
				...modelIndexSteps(collection),
				...approvalRequestOngoingIndexSteps(collection),
				...searchIndexSteps(collection),
				...exclusions
			];
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const syncTriggers = workspace.collections
		.filter((collection) => collection.sync !== false)
		.flatMap((collection) => syncTriggerSteps(collection));
	const taskProjectionTriggers: ReadonlyArray<SchemaStep> = [
		{
			id: 'sync-trigger:bolt_task-automation-run:1-drop',
			sql: 'drop trigger if exists bolt_project_automation_run on bolt_task'
		},
		{
			id: 'sync-trigger:bolt_task-automation-run:2-create',
			sql: 'create trigger bolt_project_automation_run after insert or update or delete on bolt_task for each row execute function bolt_project_automation_run()'
		}
	];
	const steps = [
		...foundation,
		...collections,
		...syncTriggers,
		...taskProjectionTriggers
	].toSorted((left, right) => left.id.localeCompare(right.id));
	return { fingerprint: fingerprintSchemaSteps(steps), steps };
};
