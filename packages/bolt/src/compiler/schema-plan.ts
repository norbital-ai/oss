import { collectionSearchTrigramIndexName } from '@norbital-ai/std/collection';
import type { Schema } from 'effect';
import {
	type CollectionMutationBaseVersion,
	type CollectionMutationGraph
} from '@norbital-ai/bolt-protocol';
import {
	canonicalSchemaStepEncoding,
	digestSchemaSteps
} from '@norbital-ai/std/reckon/hash';
export { canonicalSchemaStepEncoding, digestSchemaSteps };
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

export type SchemaStep = Readonly<{
	readonly id: string;
	/** Compiler-owned DDL, or the explicitly named bootstrap seed below; never application CRUD. */
	readonly sql: string;
}>;

/** Fingerprints the exact ordered DDL a database or replica will apply. */
export const fingerprintSchemaSteps = (steps: ReadonlyArray<SchemaStep>): string =>
	digestSchemaSteps(steps);

export type SchemaPlan = Readonly<{
	readonly fingerprint: string;
	readonly steps: ReadonlyArray<SchemaStep>;
}>;

/** Quotes a PostgreSQL identifier. Shared so plan DDL and migration DDL cannot quote differently. */
const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** Quotes one PostgreSQL text literal assembled exclusively from compiler-owned schema names. */
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const containsOpaquePolicySql = (value: unknown): boolean => {
	if (Array.isArray(value)) return value.some(containsOpaquePolicySql);
	if (value === null || typeof value !== 'object') return false;
	if ('$sql' in value) return true;
	return Object.values(value).some(containsOpaquePolicySql);
};

const policyRelationshipDependencies = (
	workspace: WorkspaceDefinition,
	rootCollection: string,
	where: unknown
): ReadonlySet<string> => {
	const dependencies = new Set<string>();
	const collections = new Map(
		workspace.collections.map((collection) => [collection.name, collection] as const)
	);
	const visit = (value: unknown, collection: string): void => {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
		const fields = collections.get(collection)?.fields ?? {};
		for (const [key, condition] of Object.entries(value)) {
			if (key === '$sql') continue;
			if (key === 'AND' || key === 'OR') {
				if (Array.isArray(condition)) {
					for (const branch of condition) visit(branch, collection);
				}
				continue;
			}
			if (key === 'NOT') {
				visit(condition, collection);
				continue;
			}
			// The where compiler gives a column precedence over a same-named relation.
			if (Object.hasOwn(fields, key)) continue;
			const relation = workspace.relations.find(
				(candidate) => candidate.source === collection && candidate.name === key
			);
			if (relation === undefined) continue;
			dependencies.add(relation.target);
			visit(condition, relation.target);
		}
	};
	visit(where, rootCollection);
	return dependencies;
};

/**
 * The compile-time policy dependency graph used by sync generations.
 *
 * Keys are collections that may be written; values are collections whose row visibility can
 * change as a result. The target collection always depends on itself. Structured relationship
 * traversals contribute their target collections automatically; authored `dependencies` are
 * additive and therefore cannot erase an edge the predicate itself proves. An opaque `$sql` read
 * conservatively depends on every synced collection because an authored dependency list cannot
 * prove which tables arbitrary SQL does not read. This is a safe migration path for existing
 * workspaces: incomplete metadata costs bounded refills, never a silently-valid proof.
 */
export const syncPolicyDependencyGraph = (
	authored: WorkspaceDefinition
): ReadonlyMap<string, ReadonlySet<string>> => {
	const workspace = withSystemCollections(authored);
	const synced = new Set(
		workspace.collections.filter(({ sync }) => sync !== false).map(({ name }) => name)
	);
	const graph = new Map<string, Set<string>>();
	const link = (source: string, dependent: string): void => {
		const targets = graph.get(source) ?? new Set<string>();
		targets.add(dependent);
		graph.set(source, targets);
	};
	for (const collection of synced) link(collection, collection);
	for (const policy of workspace.policies) {
		for (const grant of policy.grants ?? []) {
			if (grant.action !== 'read' || !synced.has(grant.collection)) continue;
			for (const dependency of policyRelationshipDependencies(
				workspace,
				grant.collection,
				grant.where
			)) {
				if (!synced.has(dependency)) {
					throw new TypeError(
						`Policy ${policy.name} read grant ${grant.collection} traverses unavailable sync dependency ${dependency}.`
					);
				}
				link(dependency, grant.collection);
			}
			const declared = grant.dependencies;
			if (declared !== undefined) {
				for (const dependency of declared) {
					if (!synced.has(dependency)) {
						throw new TypeError(
							`Policy ${policy.name} read grant ${grant.collection} declares unavailable sync dependency ${dependency}.`
						);
					}
					link(dependency, grant.collection);
				}
			}
			if (containsOpaquePolicySql(grant.where)) {
				for (const dependency of synced) link(dependency, grant.collection);
			}
		}
	}
	return new Map(
		[...graph].map(([source, dependents]) => [source, new Set([...dependents].toSorted())])
	);
};

const syncGenerationStatements = (workspace: WorkspaceDefinition): string => {
	const graph = syncPolicyDependencyGraph(workspace);
	const bump = (collection: string): string =>
		`insert into bolt_sync_generation (collection_name, generation, last_xid) values (${collection}, 1, pg_current_xact_id()::text::bigint) on conflict (collection_name) do update set generation = case when bolt_sync_generation.last_xid = excluded.last_xid then bolt_sync_generation.generation else bolt_sync_generation.generation + 1 end, last_xid = excluded.last_xid;`;
	const dependentBumps = [...graph]
		.flatMap(([source, dependents]) => {
			const indirect = [...dependents].filter((dependent) => dependent !== source);
			if (indirect.length === 0) return [];
			return [
				`if TG_TABLE_NAME = ${quoteLiteral(source)} then ${indirect.map((dependent) => bump(quoteLiteral(dependent))).join(' ')} end if;`
			];
		})
		.join(' ');
	return `${bump('TG_TABLE_NAME')} ${dependentBumps} if TG_TABLE_NAME in ('user', 'team') then ${bump("'__authority__'")} end if;`;
};

const syncInvalidatedCollectionsExpression = (workspace: WorkspaceDefinition): string => {
	const branches = [...syncPolicyDependencyGraph(workspace)].flatMap(([source, dependents]) => {
		const indirect = [...dependents].filter((dependent) => dependent !== source).toSorted();
		return indirect.length === 0
			? []
			: [`when ${quoteLiteral(source)} then ${quoteLiteral(JSON.stringify(indirect))}::jsonb`];
	});
	return `case TG_TABLE_NAME ${branches.join(' ')} else '[]'::jsonb end`;
};

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
/** Additive initialization owned by the runtime table capability that requires it. */
const systemTableInitializers: ReadonlyMap<string, SchemaStep> = new Map([
	[
		'approval_request',
		{
			id: 'collection:approval_request:zz-approval-teams-backfill',
			// repository-health:allow SQL1 -- idempotent bootstrap backfill for approval rows created before the normalized team projections existed; migrate executes every initializer inside the schema transaction.
			sql: `do $bolt_approval_team_backfill$ begin
				if to_regclass('bolt_approvals') is not null then
					update approval_request projected
					set approver_teams = coalesce((
						select jsonb_agg(distinct lower(approver.team_name))
						from bolt_approvals approval
						cross join lateral jsonb_array_elements(
							case when jsonb_typeof(approval.state #> '{operation,approval,steps}') = 'array'
							then approval.state #> '{operation,approval,steps}' else '[]'::jsonb end
						) active(step_value)
						cross join lateral jsonb_array_elements_text(
							case when jsonb_typeof(active.step_value->'approvers') = 'array'
							then active.step_value->'approvers' else '[]'::jsonb end
						) approver(team_name)
						where approval.request_id = projected.id::text
					), '[]'::jsonb),
					superseder_teams = coalesce((
						select jsonb_agg(distinct lower(superseder.team_name))
						from bolt_approvals approval
						cross join lateral jsonb_array_elements_text(
							case when jsonb_typeof(approval.state #> '{operation,approval,superceded_by}') = 'array'
							then approval.state #> '{operation,approval,superceded_by}' else '[]'::jsonb end
						) superseder(team_name)
						where approval.request_id = projected.id::text
						), '[]'::jsonb)
					where projected.status = 'ONGOING'
						and (projected.approver_teams = '[]'::jsonb or projected.superseder_teams = '[]'::jsonb);
				end if;
			end $bolt_approval_team_backfill$`
		}
	],
	[
		'bolt_audit',
		{
			id: 'collection:bolt_audit:zz-approval-request-backfill',
			// repository-health:allow SQL1 -- idempotent bootstrap backfill for approval audit rows created before request_id was normalized; migrate owns the transaction.
			sql: `update bolt_audit
				set request_id = payload->>'requestId'
				where request_id is null and payload ? 'requestId'`
		}
	],
	[
		'bolt_sync_horizon',
		{
			id: 'collection:bolt_sync_horizon:seed',
			// repository-health:allow SQL1 -- bootstrap data: the singleton is part of provisioning the
			// sync ledger, is idempotent, and runs only inside the schema plan's provisioning transaction.
			sql: 'insert into bolt_sync_horizon (singleton) values (true) on conflict (singleton) do nothing'
		}
	]
]);
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
		// repository-health:allow SQL1 -- guarded EXCLUDE-constraint DDL; the catalog read makes
		// PostgreSQL's missing `ADD CONSTRAINT IF NOT EXISTS` behavior idempotent during provisioning.
		sql: `do ${EXCLUSION_TAG} begin if not exists (select 1 from pg_constraint where conname = '${exclusion.name}' and conrelid = '${collectionName}'::regclass) then alter table ${quoteIdentifier(collectionName)} add constraint ${quoteIdentifier(exclusion.name)} exclude using gist (${elements.join(', ')}); end if; end ${EXCLUSION_TAG}`
	};
};

/** Installs the database-owned sync capture for one collection after its table exists. */
const syncTriggerSteps = (collectionName: string): ReadonlyArray<SchemaStep> => [
	{
		id: `sync-trigger:${collectionName}:1-drop`,
		sql: `drop trigger if exists bolt_sync_capture on ${quoteIdentifier(collectionName)}`
	},
	{
		id: `sync-trigger:${collectionName}:2-create`,
		sql: `create trigger bolt_sync_capture after insert or update or delete on ${quoteIdentifier(collectionName)} for each row execute function bolt_capture_sync_change()`
	}
];

/** Owns build schema plan behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
export const buildSchemaPlan = (authored: WorkspaceDefinition): SchemaPlan => {
	// Runtime-owned collections are planned exactly like authored ones: authored queries read them,
	// so they need the same row columns rather than a private hand-written table shape.
	const workspace = withSystemCollections(authored);
	const generationStatements = syncGenerationStatements(authored);
	const invalidatedCollections = syncInvalidatedCollectionsExpression(authored);
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
		/**
		 * `approval_request.locked_record_refs` is gone, so the column goes with it.
		 *
		 * It tracked the records a request governed, beside the history that was already recording
		 * every one of them. Two sources for one fact meant the tracked one drifted: a revision that
		 * created a record never joined it, and a cascade never appeared at all. The ledger is now
		 * derived from `bolt_collection_history` by `approval_id`, and a column nothing writes is worse
		 * than absent - it reads as authoritative.
		 */
		{
			id: 'bolt:drop-approval-locked-record-refs',
			sql: 'alter table if exists approval_request drop column if exists locked_record_refs'
		},
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
			// Every sync-visible row enters the ordered outbox with both full images, and advances the
			// direct/dependent collection generations in the same transaction. Before-images make a
			// policy transition decidable without consulting a page; dependent generation bumps cover
			// the cases where a linking row changes visibility without writing the visible collection.
			id: 'bolt:function-sync-capture',
			sql: `create or replace function bolt_capture_sync_change() returns trigger language plpgsql as $bolt_sync_capture$ declare mutation_id text := nullif(current_setting('bolt.mutation_id', true), ''); begin ${generationStatements} if TG_OP = 'DELETE' then insert into bolt_sync_outbox (collection_name, record_id, operation, mutation_id, before_record, after_record, invalidated_collections) values (TG_TABLE_NAME, OLD.id::text, 'delete', mutation_id, to_jsonb(OLD), null, ${invalidatedCollections}); return OLD; end if; insert into bolt_sync_outbox (collection_name, record_id, operation, mutation_id, before_record, after_record, invalidated_collections) values (TG_TABLE_NAME, NEW.id::text, case when TG_OP = 'INSERT' then 'create' else 'update' end, mutation_id, case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end, to_jsonb(NEW), ${invalidatedCollections}); return NEW; end $bolt_sync_capture$`
		},
		{
			// The task queue remains private: command inputs are arbitrary and may contain secrets.
			// Its automation rows project into a sync-visible collection inside the same transaction,
			// so queue code writes one source of truth and the browser never reads the queue itself.
			id: 'bolt:function-automation-run-projection',
			sql: `create or replace function bolt_project_automation_run() returns trigger language plpgsql as $bolt_automation_run$ begin if TG_OP = 'DELETE' then if OLD.command like 'automations.%' then delete from automation_run where task_id = OLD.effect_id; end if; return OLD; end if; if NEW.command like 'automations.%' then insert into automation_run (task_id, name, status, attempts, max_attempts, progress, progress_sequence, progress_updated_at, result, error, next_run_at) values (NEW.effect_id, substring(NEW.command from length('automations.') + 1), NEW.status, NEW.attempts, NEW.max_attempts, NEW.progress, NEW.progress_sequence, NEW.progress_updated_at, NEW.result, NEW.error, case when NEW.status in ('pending', 'resuming') then NEW.run_at else null end) on conflict (task_id) do update set name = excluded.name, status = excluded.status, attempts = excluded.attempts, max_attempts = excluded.max_attempts, progress = excluded.progress, progress_sequence = excluded.progress_sequence, progress_updated_at = excluded.progress_updated_at, result = excluded.result, error = excluded.error, next_run_at = excluded.next_run_at, updated_at = now(), row_version = automation_run.row_version + 1; end if; return NEW; end $bolt_automation_run$`
		},
		{
			// Agent task inputs contain private authority and message references, so clients receive only
			// the lane-safe lifecycle projection. The trigger keeps it atomic with the queue row.
			id: 'bolt:function-agent-run-projection',
			sql: `create or replace function bolt_project_agent_run() returns trigger language plpgsql as $bolt_agent_run$ begin if TG_OP = 'DELETE' then if OLD.command = 'agents.execute' then delete from agent_run where task_id = OLD.effect_id; end if; return OLD; end if; if NEW.command = 'agents.execute' then insert into agent_run (task_id, conversation_id, turn_id, agent_name, status, position, error, next_run_at) values (NEW.effect_id, NEW.input->>'conversationId', NEW.input->>'turnId', NEW.input->>'agent', case NEW.status when 'pending' then 'queued' when 'done' then 'completed' else NEW.status end, NEW.position, NEW.error, case when NEW.status in ('pending', 'resuming', 'running') then NEW.run_at else null end) on conflict (task_id) do update set conversation_id = excluded.conversation_id, turn_id = excluded.turn_id, agent_name = excluded.agent_name, status = excluded.status, position = excluded.position, error = excluded.error, next_run_at = excluded.next_run_at, updated_at = now(), row_version = agent_run.row_version + 1; end if; return NEW; end $bolt_agent_run$`
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
			const initializer = systemTableInitializers.get(collection.name);
			const fields = Object.entries(collection.fields)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, field]) => ({ name, sql: renderColumn(name, field) }));
			const table = SchemaPlanValues.quoteIdentifier(collection.name);
			const sql = `create table if not exists ${table} (${SYSTEM_COLUMNS}${fields.length === 0 ? '' : `, ${fields.map(({ sql }) => sql).join(', ')}`})`;
			return [
				{ id: `collection:${collection.name}`, sql },
				// Runtime-owned tables have no authored Drizzle lineage. `create table if not exists`
				// provisions a new tenant but leaves an existing table at its old shape, so adding a
				// field to (for example) `bolt_task` used to make the new runtime query a column no
				// deploy could create. Re-apply every declared field as an idempotent additive step.
				// Existing columns are untouched; a newly required column without a default fails on
				// populated data instead of pretending the migration succeeded.
				...fields.map(({ name, sql }) => ({
					id: `collection:${collection.name}:column:${name}`,
					sql: `alter table ${table} add column if not exists ${sql}`
				})),
				...declaredIndexSteps(collection),
				...modelIndexSteps(collection),
				...searchIndexSteps(collection),
				...(initializer === undefined ? [] : [initializer]),
				...exclusions
			];
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const syncTriggers = workspace.collections
		.filter((collection) => collection.sync !== false)
		.flatMap(({ name }) => syncTriggerSteps(name));
	const taskProjectionTriggers: ReadonlyArray<SchemaStep> = [
		{
			id: 'sync-trigger:bolt_task-agent-run:1-drop',
			sql: 'drop trigger if exists bolt_project_agent_run on bolt_task'
		},
		{
			id: 'sync-trigger:bolt_task-agent-run:2-create',
			sql: 'create trigger bolt_project_agent_run after insert or update or delete on bolt_task for each row execute function bolt_project_agent_run()'
		},
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

/**
 * Exact ordered DDL a browser replica receives from `sync.provisioning`.
 *
 * Both the endpoint and `sync.schema` consume this function. That shared source is what makes the
 * advertised migration digest a verification of the bytes that are later applied, instead of a
 * digest of a similar plan assembled along another path.
 */
export const replicaProvisioningSteps = (
	workspace: WorkspaceDefinition
): ReadonlyArray<SchemaStep> => {
	const plan = buildSchemaPlan(workspace);
	/**
	 * System tables are created *before* the workspace lineage, not after it.
	 *
	 * A workspace migration may reference a system table: `job_assignments.assignee_user_id`
	 * declares a relation to `user`, and drizzle emits that foreign key inside the workspace
	 * lineage. A server already holds those tables by the time a lineage is applied, so the order
	 * never mattered there. A browser replica applies this exact list into an empty database, and
	 * the constraint ran before anything had created `user` — provisioning died at that step
	 * (`relation "user" does not exist`) and the workspace fell back to server-only with no replica
	 * at all. Only the creation steps move; indexes, initialisers and exclusions stay after the
	 * lineage, where a tenant table they touch already exists.
	 */
	const isSystemTableCreation = (id: string): boolean => {
		const parts = id.split(':');
		if (parts[0] !== 'collection' || parts[1] === undefined) return false;
		if (!systemTableNames.has(parts[1])) return false;
		return parts.length === 2 || parts[2] === 'column';
	};
	const systemTables = plan.steps.filter(({ id }) => isSystemTableCreation(id));
	const remaining = plan.steps.filter(({ id }) => !isSystemTableCreation(id));
	return [
		...remaining.filter(({ id }) => id.startsWith('bolt:')),
		...systemTables,
		...[...(workspace.migrations ?? [])]
			.toSorted((left, right) => left.tag.localeCompare(right.tag))
			.flatMap((entry) =>
				entry.statements.map((sql, index) => ({ id: `lineage:${entry.tag}:${index}`, sql }))
			),
		...remaining.filter(({ id }) => !id.startsWith('bolt:'))
	];
};

export type MutationCompatibilityResolution = Readonly<
	| { readonly resolution: 'accepted'; readonly graph: CollectionMutationGraph; readonly baseVersions: ReadonlyArray<CollectionMutationBaseVersion> }
	| { readonly resolution: 'rebased'; readonly graph: CollectionMutationGraph; readonly baseVersions: ReadonlyArray<CollectionMutationBaseVersion> }
	| { readonly resolution: 'quarantined'; readonly reason: string }
>;

/**
 * Selects and applies the one compiler-generated forward adapter for an offline mutation.
 *
 * Unknown fields are deliberately left in the transformed graph. The ordinary declarative graph
 * validator then refuses them, so an incomplete adapter can never turn a removed field into a
 * silently dropped write.
 */
export const reconcileMutationSchema = (
	workspace: WorkspaceDefinition,
	input: Readonly<{
		readonly fromSchemaFingerprint: string;
		readonly toSchemaFingerprint: string;
		readonly ageMillis: number;
		readonly graph: CollectionMutationGraph;
		readonly baseVersions: ReadonlyArray<CollectionMutationBaseVersion>;
	}>
): MutationCompatibilityResolution => {
	const compatibility = workspace.mutationCompatibility;
	if (compatibility === undefined)
		return {
			resolution: 'quarantined',
			reason: 'The compiled workspace carries no mutation compatibility lineage.'
		};
	const horizon = compatibility.offlineHorizonMillis;
	if (input.ageMillis > horizon)
		return {
			resolution: 'quarantined',
			reason: `The mutation was authored ${input.ageMillis}ms ago, outside the ${horizon}ms schema compatibility horizon.`
		};
	if (input.fromSchemaFingerprint === input.toSchemaFingerprint)
		return { resolution: 'accepted', graph: input.graph, baseVersions: input.baseVersions };
	const adapter = compatibility.adapters.find(
		(entry) => entry.fromSchemaFingerprint === input.fromSchemaFingerprint
	);
	if (adapter === undefined)
		return {
			resolution: 'quarantined',
			reason: `No retained compatibility adapter understands schema ${input.fromSchemaFingerprint}.`
		};
	if (
		adapter.fieldRenames?.[input.graph.collection]?.['id'] !== undefined &&
		adapter.fieldRenames[input.graph.collection]?.['id'] !== 'id'
	)
		return {
			resolution: 'quarantined',
			reason: `Compatibility adapter for ${input.graph.collection} cannot rewrite record identity.`
		};
	if ((adapter.incompatibleActions?.[input.graph.collection] ?? []).includes(input.graph.action))
		return {
			resolution: 'quarantined',
			reason: `Compatibility adapter for ${input.graph.collection} cannot preserve ${input.graph.action} semantics.`
		};
	const collection = adapter.collectionRenames?.[input.graph.collection] ?? input.graph.collection;
	type AdaptedValues =
		| Readonly<{ readonly ok: true; readonly values: Readonly<Record<string, Schema.Json>> }>
		| Readonly<{ readonly ok: false; readonly reason: string }>;
	const oldCollectionName = (current: string): string =>
		Object.entries(adapter.collectionRenames ?? {}).find(([, target]) => target === current)?.[0] ??
		current;
	const baseVersionKeys = new Set(
		input.baseVersions.map(({ row }) => `${row.collection}\u0000${row.recordId}`)
	);
	const renameValues = (
		oldName: string,
		currentName: string,
		values: Readonly<Record<string, Schema.Json>>,
		action: 'create' | 'update'
	): AdaptedValues => {
		if ((adapter.incompatibleActions?.[oldName] ?? []).includes(action))
			return {
				ok: false,
				reason: `Compatibility adapter for ${oldName} cannot preserve ${action} semantics.`
			};
		const renames = adapter.fieldRenames?.[oldName] ?? {};
		const incompatible = new Set(adapter.incompatibleFields?.[oldName] ?? []);
		if (renames['id'] !== undefined && renames['id'] !== 'id')
			return {
				ok: false,
				reason: `Compatibility adapter for ${oldName} cannot rewrite record identity.`
			};
		const adapted: Record<string, Schema.Json> = {};
		for (const [field, value] of Object.entries(values)) {
			if (incompatible.has(field))
				return {
					ok: false,
					reason: `Compatibility adapter for ${oldName} cannot losslessly translate field ${field}.`
				};
			const renamed = renames[field] ?? field;
			if (renamed in adapted)
				return {
					ok: false,
					reason: `Compatibility adapter for ${oldName} maps more than one field to ${renamed}.`
				};
			const relation = workspace.relations.find(
				(entry) =>
					entry.source === currentName && entry.cardinality === 'many' && entry.name === renamed
			);
			if (relation === undefined || !Array.isArray(value)) {
				adapted[renamed] = value;
				continue;
			}
			const nestedOldName = oldCollectionName(relation.target);
			// A many relationship included in an update is a complete desired state. Rows omitted from
			// it are deletes even though they do not appear as child objects in the graph.
			if (
				action === 'update' &&
				(adapter.incompatibleActions?.[nestedOldName] ?? []).includes('delete')
			)
				return {
					ok: false,
					reason: `Compatibility adapter for ${nestedOldName} cannot preserve delete semantics.`
				};
			const children: Array<Schema.Json> = [];
			for (const child of value) {
				if (child === null || typeof child !== 'object' || Array.isArray(child)) {
					children.push(child);
					continue;
				}
				const childValues = child as Readonly<Record<string, Schema.Json>>;
				const childId = childValues['id'];
				const childAction =
					action === 'create' ||
					typeof childId !== 'string' ||
					!baseVersionKeys.has(`${nestedOldName}\u0000${childId}`)
						? 'create'
						: 'update';
				const nested = renameValues(
					nestedOldName,
					relation.target,
					childValues,
					childAction
				);
				if (!nested.ok) return nested;
				children.push(nested.values);
			}
			adapted[renamed] = children;
		}
		return { ok: true, values: adapted };
	};
	const adaptedValues =
		input.graph.action === 'delete'
			? undefined
			: renameValues(input.graph.collection, collection, input.graph.values, input.graph.action);
	if (adaptedValues !== undefined && !adaptedValues.ok)
		return { resolution: 'quarantined', reason: adaptedValues.reason };
	const graph: CollectionMutationGraph =
		input.graph.action === 'delete'
			? { ...input.graph, collection }
			: { ...input.graph, collection, values: adaptedValues!.values };
	return {
		resolution: 'rebased',
		graph,
		baseVersions: input.baseVersions.map((entry) => ({
			...entry,
			row: {
				...entry.row,
				collection:
					adapter.collectionRenames?.[entry.row.collection] ?? entry.row.collection
			}
		}))
	};
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
			!step.id.startsWith('sync-trigger:') &&
			// Derived from the declaration rather than from a naming convention. `team` and
			// `auth_config` are just as necessary to authentication as Better Auth's four models, so a
			// prefix or allowlist maintained beside the declarations could silently leave a new host
			// unable to authenticate anybody.
			IDENTITY_COLLECTION_NAMES.some(
				(name) => step.id === `collection:${name}` || step.id.startsWith(`collection:${name}:`)
			)
	);
