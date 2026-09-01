import { canonicalSchemaStepEncoding, digestSchemaSteps } from '@norbital-ai/std/reckon/hash';
export { canonicalSchemaStepEncoding, digestSchemaSteps };
import type { CollectionIndexRequirement } from '@norbital-ai/bolt-protocol/collections';
import type { ModelExclusion, ModelIndex } from '../../authoring/models-schema.js';
import {
	compileModel,
	describeModel,
	SEARCH_DOCUMENT_COLUMN,
	searchDocumentExpression,
	searchTextExpression,
	searchableColumns
} from '../../authoring/model-introspection.js';
import { INTERNAL_SYSTEM_MODELS, SYSTEM_MODELS } from '../../authoring/system-models.js';
import { defineSystemRowModel } from '../../authoring/system-row-model.js';
import type {
	CollectionDefinition,
	FieldDefinition,
	WorkspaceDefinition
} from '../../authoring/workspace-schema.js';
import { collection } from '../../authoring/workspace-schema.js';
import { approvalRefusal } from '../../authoring/approval-validation.js';
import { withSystemCollections } from './system-collections.js';

type SchemaStep = Readonly<{
	readonly id: string;
	readonly sql: string;
}>;

export const fingerprintSchemaSteps = (steps: ReadonlyArray<SchemaStep>): string =>
	digestSchemaSteps(steps);

export type SchemaPlan = Readonly<{
	readonly fingerprint: string;
	readonly steps: ReadonlyArray<SchemaStep>;
}>;

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

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

const SchemaPlanValues = {
	columnType: (field: FieldDefinition): string =>
		field.sqlType ?? SchemaPlanValues.sqlType(field.type),
	sqlType: (type: string): string => {
		switch (type) {
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

const EXCLUSION_TAG = '$bolt_exclusion$';

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

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

export const collectionSearchDocumentIndexName = (collectionName: string): string =>
	boundedCollectionIndexName(`${collectionName}_search_document_gin_idx`, 'search_gin_idx');

export const collectionSearchTextTrigramIndexName = (collectionName: string): string =>
	boundedCollectionIndexName(`${collectionName}_search_text_trgm_idx`, 'trgm_idx');

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

const declaredIndexSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> =>
	Object.entries(collection.fields)
		.filter(([, field]) => field.indexed && field.primaryKey !== true && field.unique !== true)
		.map(([column, field]) => ({ column, unique: field.unique === true }))
		.toSorted((left, right) => left.column.localeCompare(right.column))
		.map(({ column, unique }) => ({
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

const relationshipIndexRequirements = (
	definition: WorkspaceDefinition
): ReadonlyArray<CollectionIndexRequirement> =>
	definition.relations.flatMap((relation) =>
		[relation.from, relation.to].flatMap((endpoint) =>
			endpoint === undefined || endpoint.column === 'id'
				? []
				: [
						{
							collection: endpoint.collection,
							field: endpoint.column,
							reason: 'relationship' as const
						}
					]
		)
	);

const hasDeclaredIndex = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
	fieldName: string
): boolean => {
	const field = collection.fields[fieldName] ?? systemRowFields[fieldName];
	if (
		field?.indexed === true ||
		field?.primaryKey === true ||
		field?.unique === true ||
		fieldName === 'id'
	)
		return true;
	return (collection.indexes ?? []).some(
		(index) => index.columns.length === 1 && index.columns[0] === fieldName
	);
};

/** Index DDL owned by the schema plan for every field proven necessary by an effective plan. */
const effectiveIndexSteps = (
	collections: ReadonlyArray<
		CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
	>,
	requirements: ReadonlyArray<CollectionIndexRequirement>
): ReadonlyArray<SchemaStep> => {
	const byName = new Map(collections.map((definition) => [definition.name, definition] as const));
	const unique = new Map<string, CollectionIndexRequirement>();
	for (const requirement of requirements)
		unique.set(`${requirement.collection}.${requirement.field}`, requirement);
	return [...unique.values()]
		.toSorted((left, right) =>
			`${left.collection}.${left.field}`.localeCompare(`${right.collection}.${right.field}`)
		)
		.flatMap((requirement) => {
			const collection = byName.get(requirement.collection);
			if (collection === undefined)
				throw new TypeError(
					`Effective plan requires an index on unknown collection ${requirement.collection}.${requirement.field}.`
				);
			if (
				collection.fields[requirement.field] === undefined &&
				systemRowFields[requirement.field] === undefined
			)
				throw new TypeError(
					`Effective plan requires an index on unknown field ${requirement.collection}.${requirement.field}.`
				);
			if (hasDeclaredIndex(collection, requirement.field)) return [];
			return [
				{
					id: `collection:${requirement.collection}:live-index:${requirement.field}`,
					sql: `create index if not exists ${quoteIdentifier(collectionIndexName(requirement.collection, requirement.field))} on ${quoteIdentifier(requirement.collection)} (${quoteIdentifier(requirement.field)})`
				}
			];
		});
};

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

const exclusionStep = (collectionName: string, exclusion: ModelExclusion): SchemaStep => {
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
		sql: `do ${EXCLUSION_TAG} begin if not exists (select 1 from pg_constraint where conname = '${exclusion.name}' and conrelid = '${collectionName}'::regclass) then alter table ${quoteIdentifier(collectionName)} add constraint ${quoteIdentifier(exclusion.name)} exclude using gist (${elements.join(', ')}); end if; end ${EXCLUSION_TAG}`
	};
};

export const buildSchemaPlan = (
	authored: WorkspaceDefinition,
	requirements: ReadonlyArray<CollectionIndexRequirement> = []
): SchemaPlan => {
	const authorityRefusal = approvalRefusal(authored);
	if (authorityRefusal !== undefined) throw new TypeError(authorityRefusal);
	const workspace = withSystemCollections(authored);
	const foundation: ReadonlyArray<SchemaStep> = [
		{ id: 'bolt:extension-btree-gist', sql: 'create extension if not exists btree_gist' },
		{ id: 'bolt:extension-pg-trgm', sql: 'create extension if not exists pg_trgm' },
		{ id: 'bolt:extension-vector', sql: 'create extension if not exists vector' },
		{
			id: 'bolt:function-assert',
			sql: "create or replace function bolt_assert(ok boolean, message text) returns void language plpgsql volatile parallel unsafe as $bolt_assert$ begin if ok is not true then raise exception '%', message using errcode = '40001'; end if; end $bolt_assert$"
		},
		{
			id: 'bolt:function-instant',
			sql: "create or replace function bolt_instant(value text) returns timestamptz language sql immutable parallel safe as $bolt_instant$ select nullif(value, '')::date::timestamp at time zone 'UTC' $bolt_instant$"
		},
		{
			id: 'bolt:function-daterange',
			sql: "create or replace function bolt_daterange(payload jsonb) returns daterange language sql immutable parallel safe as $bolt_daterange$ select daterange(nullif(payload->>'start', '')::date, nullif(payload->>'end', '')::date, '[)') $bolt_daterange$"
		},
		{
			id: 'bolt:function-automation-run-projection',
			sql: `create or replace function bolt_project_automation_run() returns trigger language plpgsql as $bolt_automation_run$ begin if TG_OP = 'DELETE' then if OLD.command like 'automations.%' then delete from automation_run where task_id = OLD.effect_id; end if; return OLD; end if; if NEW.command like 'automations.%' then insert into automation_run (task_id, name, status, progress, progress_sequence, progress_updated_at, result, error) values (NEW.effect_id, substring(NEW.command from length('automations.') + 1), NEW.status, NEW.progress, NEW.progress_sequence, NEW.progress_updated_at, NEW.result, NEW.error) on conflict (task_id) do update set name = excluded.name, status = excluded.status, progress = excluded.progress, progress_sequence = excluded.progress_sequence, progress_updated_at = excluded.progress_updated_at, result = excluded.result, error = excluded.error, updated_at = now(), row_version = automation_run.row_version + 1; end if; return NEW; end $bolt_automation_run$`
		}
	];
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
							`${quoteIdentifier(SEARCH_DOCUMENT_COLUMN)} tsvector generated always as (${searchDocumentExpression(searchColumns, collection.fields)}) stored`
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
	const taskProjectionTriggers: ReadonlyArray<SchemaStep> = [
		{
			id: 'projection-trigger:bolt_task-automation-run:1-drop',
			sql: 'drop trigger if exists bolt_project_automation_run on bolt_task'
		},
		{
			id: 'projection-trigger:bolt_task-automation-run:2-create',
			sql: 'create trigger bolt_project_automation_run after insert or update or delete on bolt_task for each row execute function bolt_project_automation_run()'
		}
	];
	const effectiveIndexes = effectiveIndexSteps(
		[...workspace.collections, ...internalSystemTables],
		[...relationshipIndexRequirements(workspace), ...requirements]
	);
	const steps = [
		...foundation,
		...collections,
		...effectiveIndexes,
		...taskProjectionTriggers
	].toSorted((left, right) => left.id.localeCompare(right.id));
	return { fingerprint: fingerprintSchemaSteps(steps), steps };
};
