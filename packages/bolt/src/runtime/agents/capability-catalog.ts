import {
	Client,
	ProtocolError,
	SdkHttpError,
	StreamableHTTPClientTransport,
	specTypeSchemas,
	withInputRequired,
	type CallToolResult as CompleteCallToolResult,
	type FetchLike,
	type InputRequiredResult,
	type StandardSchemaV1
} from '@modelcontextprotocol/client';
import { Effect, Option, Schema, SchemaIssue } from 'effect';
import type { Context as EffectContext } from 'effect/Context';
import { Prompt } from 'effect/unstable/ai';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	ImageAsset,
	ConversationId,
	WorkbenchId
} from '@norbital-ai/bolt-protocol/facilities';
import { getErrorMessage, toError } from '@norbital-ai/std';
import {
	SkillDeclaration,
	type McpToolRoute,
	type RelationDefinition,
	type ToolDeclaration,
	type WorkspaceDefinition
} from '#lib/authoring/workspace-schema.js';
import type { CollectionInputSelection } from '#lib/authoring/collection-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { encodeCollectionCursor } from '#lib/runtime/collections/read/cursor.js';
import type { ConnectorInterface, HostToolsInterface } from '#lib/runtime/facilities/services.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as EnvoyInbox from '#lib/runtime/envoys/inbox.js';
import * as Workspace from '#lib/runtime/workspace.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { INTEGRATION_HTTP_OPERATION, IntegrationHttpResponse } from '@norbital-ai/bolt-protocol';

export class SkillError extends Schema.TaggedError<SkillError>()(
	'Bolt.CapabilityCatalog.SkillError',
	{
		name: Schema.String,
		reason: Schema.Literals(['invalid-name', 'missing', 'unreadable'])
	}
) {
	readonly category = 'skill' as const;
	readonly retryable = false;
	readonly message = `The skill "${this.name}" is not available: ${this.reason}.`;
}

export class ToolNotAllowed extends Schema.TaggedError<ToolNotAllowed>()(
	'Bolt.CapabilityCatalog.ToolNotAllowed',
	{ agent: Schema.NonEmptyString, tool: Schema.NonEmptyString }
) {
	readonly category = 'tool-access' as const;
	readonly retryable = false;
	readonly message = `The tool "${this.tool}" is not allowed for the agent "${this.agent}".`;
}

/**
 * A tool call whose input does not decode. Distinct from `ToolNotAllowed`: the tool exists and the
 * agent may use it; the model sent the wrong shape. `path` names the offending field so the model
 * can repair the call, and `detail` is the sentence it is shown.
 */
export class InvalidToolInput extends Schema.TaggedError<InvalidToolInput>()(
	'Bolt.CapabilityCatalog.InvalidToolInput',
	{ tool: Schema.NonEmptyString, path: Schema.String, message: Schema.String }
) {
	readonly category = 'tool-input' as const;
	readonly retryable = false;
	readonly detail = `Invalid input for tool "${this.tool}"${this.path === '' ? '' : ` at "${this.path}"`}: ${this.message}`;
}

const formatIssuePath = (
	path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
): string =>
	path
		.map((segment) => (segment instanceof Object ? segment.key : segment))
		.map((key, index) =>
			Number.isInteger(key) ? `[${String(key)}]` : `${index === 0 ? '' : '.'}${String(key)}`
		)
		.join('');

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export const invalidToolInput = (tool: string, error: Schema.SchemaError): InvalidToolInput => {
	const issues = formatIssues(error.issue).issues;
	const issue = issues.find(({ path }) => path !== undefined && path.length > 0) ?? issues[0];
	return new InvalidToolInput({
		tool,
		path: formatIssuePath(issue?.path ?? []),
		message: issue?.message ?? 'The input does not match the tool schema.'
	});
};

export class AgentModelUnavailable extends Schema.TaggedError<AgentModelUnavailable>()(
	'Bolt.ModelRegistry.ModelUnavailable',
	{
		model: Schema.NonEmptyString,
		reason: Schema.Literals(['invalid-catalog', 'not-found', 'context-missing'])
	}
) {
	readonly category = 'agent-model' as const;
	readonly message = `The model "${this.model}" is unavailable: ${this.reason}.`;
}

export class McpToolError extends Schema.TaggedError<McpToolError>()(
	'Bolt.CapabilityCatalog.McpToolError',
	{
		server: Schema.NonEmptyString,
		tool: Schema.NonEmptyString,
		reason: Schema.Literals(['invalid-input', 'invalid-response', 'http-status', 'protocol-error']),
		detail: Schema.NonEmptyString
	}
) {
	readonly category = 'mcp' as const;
	readonly retryable = this.reason === 'http-status';
	readonly message = `MCP ${this.server}:${this.tool} failed: ${this.detail}.`;
}

const TaskProjection = Schema.Struct({
	id: ConversationId,
	workbench_id: WorkbenchId,
	agent_id: AgentId,
	parent_id: Schema.optionalKey(Schema.NullOr(ConversationId)),
	subject_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	status: Schema.NonEmptyString
});
const MessageProjection = Schema.Struct({
	conversation_id: ConversationId,
	sequence: Schema.Natural,
	author: Schema.Struct({
		kind: Schema.NonEmptyString,
		id: Schema.optionalKey(Schema.NonEmptyString)
	}),
	message: Schema.toEncoded(Prompt.Message)
});
const decodeRows = <S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	rows: ReadonlyArray<unknown>
) => Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(schema)(row));
const messageText = (message: Prompt.MessageEncoded): string =>
	isString(message.content)
		? message.content
		: message.content
				.flatMap((part) => (part.type === 'text' || part.type === 'reasoning' ? [part.text] : []))
				.join('\n');

const SystemToolNames = Schema.Literals([
	'todo',
	'compact',
	'describe_workspace',
	'list_skills',
	'read_skill',
	'search_task_history',
	'read_messages',
	'use_image',
	'read_collection',
	'write_collection'
]);
type SystemToolName = Schema.Schema.Type<typeof SystemToolNames>;

export const isSystemTool = Schema.is(SystemToolNames);
const isString = Schema.is(Schema.String);

const objectInput = (
	properties: Schema.JsonObject,
	required: ReadonlyArray<string> = []
): Schema.JsonObject => ({
	type: 'object',
	properties,
	required: [...required],
	additionalProperties: false
});

/** Only the root planning loop exposes this capability. Persistence belongs to that loop. */
export const PlanUpdateInput = Schema.Union([
	Schema.Struct({
		operation: Schema.Literal('replace'),
		expectedRevision: Schema.Natural,
		body: Schema.NonEmptyString
	}),
	Schema.Struct({
		operation: Schema.Literal('patch'),
		expectedRevision: Schema.Natural,
		oldText: Schema.NonEmptyString,
		newText: Schema.String
	})
]);

export const planToolSpec: ToolDeclaration = {
	name: 'update_plan',
	command: 'platform:update_plan',
	description:
		'Create or revise the draft Plan only. replace writes the complete Markdown plan; patch replaces exactly one matching oldText. Supply expectedRevision (0 before creation). Preserve requirements, constraints and acceptance checks. This never executes the plan.',
	inputSchema: objectInput(
		{
			operation: { type: 'string', enum: ['replace', 'patch'] },
			expectedRevision: { type: 'integer', minimum: 0 },
			body: { type: 'string', minLength: 1 },
			oldText: { type: 'string', minLength: 1 },
			newText: { type: 'string' }
		},
		['operation', 'expectedRevision']
	)
};

export const systemToolSpecs: ReadonlyArray<ToolDeclaration> = [
	{
		name: 'wait',
		description:
			"Wait for background work — jobs started with background:true on a tool call, and child conversations — for up to timeoutSeconds (at most 600; wait again when it runs out). Returns as soon as any of them settles, with its result; with reason 'message' when the person has written to you — answer them, then wait again; or with reason 'timeout' and what is still running. With nothing named it waits on everything this turn started.",
		command: 'platform:wait',
		inputSchema: objectInput({
			jobs: { type: 'array', items: { type: 'string', minLength: 1 } },
			conversations: { type: 'array', items: { type: 'string', format: 'uuid' } },
			timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600 }
		})
	},
	{
		name: 'todo',
		description:
			"Read or replace this conversation's ordered checklist — the person watches it, so any work of three or more steps sets it first and keeps it current. `set` replaces the whole list: stable ids, at most one item doing, a done item stays done and unchanged.",
		command: 'platform:todo',
		inputSchema: objectInput(
			{
				operation: { type: 'string', enum: ['set', 'read'] },
				items: {
					type: 'array',
					maxItems: 100,
					items: objectInput(
						{
							id: { type: 'string', minLength: 1 },
							text: { type: 'string', minLength: 1 },
							status: { type: 'string', enum: ['pending', 'doing', 'done'] }
						},
						['id', 'text', 'status']
					)
				}
			},
			['operation']
		)
	},
	{
		name: 'compact',
		description:
			'Checkpoint this conversation: completed tool exchanges are summarized at your next step, the current instruction kept. Use it when older detail is in the way or a phase is finished; the runtime does it anyway at its context limit.',
		command: 'platform:compact',
		inputSchema: objectInput(
			{
				reason: {
					type: 'string',
					minLength: 1,
					description: 'Why a checkpoint helps here. Recorded with it.'
				}
			},
			['reason']
		)
	},
	{
		name: 'describe_workspace',
		description:
			'This workspace in one answer: each reachable collection with its fields, values, relations and write contract; apps, automations, envoys, integrations; where the source lives. Call once, first.',
		command: 'platform:describe_workspace'
	},
	{
		name: 'list_skills',
		description:
			'List the skills available to this run — the workspace’s, the platform’s and your own. Read a body only when relevant.',
		command: 'platform:list_skills'
	},
	{
		name: 'read_skill',
		description:
			'Read one skill from list_skills by exact name — whole, or one `## section` by its title (list_skills names them).',
		command: 'platform:read_skill',
		inputSchema: objectInput(
			{ name: { type: 'string', minLength: 1 }, section: { type: 'string', minLength: 1 } },
			['name']
		)
	},
	{
		name: 'search_task_history',
		description:
			'Search earlier messages: this Task, its workbench, or every conversation of this person (mine) — each hit names its conversationId.',
		command: 'platform:search_task_history',
		inputSchema: objectInput({
			scope: { type: 'string', enum: ['this_task', 'workbench', 'mine'] },
			query: { type: 'string' },
			limit: { type: 'integer', minimum: 1, maximum: 50 }
		})
	},
	{
		name: 'read_messages',
		description:
			'Read unread group messages in this chat that did not address you, oldest first, and mark them read; as the channel last reported them, from when recording began. Attachments are descriptors; admit an image with use_image.',
		command: 'platform:read_messages',
		inputSchema: objectInput({
			limit: { type: 'integer', minimum: 1, maximum: 50 }
		})
	},
	{
		name: 'use_image',
		description: 'Admit one image descriptor for your next step; the host resolves the bytes.',
		command: 'platform:use_image',
		inputSchema: objectInput(
			{
				key: { type: 'string', minLength: 1 },
				name: { type: 'string', minLength: 1 },
				mimeType: { type: 'string', minLength: 1 },
				size: { type: 'integer', minimum: 1 },
				detail: { type: 'string', enum: ['auto', 'low', 'high'] }
			},
			['key', 'name', 'mimeType', 'size']
		)
	},
	{
		name: 'read_collection',
		description:
			'Read one page of a collection (default 50 rows); continue with cursor. Narrow it with `where` (exact field matches) and read only the columns you need with `columns` — a row that is too large to return names its heaviest columns, and selecting the others reads it.',
		command: 'platform:read_collection',
		inputSchema: objectInput(
			{
				collection: { type: 'string', minLength: 1 },
				limit: { type: 'integer', minimum: 1, maximum: 50 },
				cursor: { type: 'string', minLength: 1 },
				where: { type: 'object', additionalProperties: true },
				columns: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }
			},
			['collection']
		)
	},
	{
		name: 'write_collection',
		description:
			'Create, update or delete one record through its declared contract; update and delete name the id. The answer is the stored row — no read-back needed.',
		command: 'platform:write_collection',
		inputSchema: objectInput(
			{
				collection: { type: 'string', minLength: 1 },
				operation: { type: 'string', enum: ['create', 'update', 'delete'] },
				id: { type: 'string', minLength: 1 },
				values: { type: 'object', additionalProperties: true }
			},
			['collection', 'operation']
		)
	}
];

export const TodoItem = Schema.Struct({
	id: Schema.NonEmptyString,
	text: Schema.NonEmptyString,
	status: Schema.Literals(['pending', 'doing', 'done'])
});
export interface TodoItem extends Schema.Schema.Type<typeof TodoItem> {}
export const TodoList = Schema.Struct({ items: Schema.Array(TodoItem) });
export interface TodoList extends Schema.Schema.Type<typeof TodoList> {}

const SkillNameInput = Schema.Struct({
	name: Schema.NonEmptyString,
	section: Schema.optionalKey(Schema.NonEmptyString)
});

/** The person's own skills, where the host keeps a private store; none anywhere else. */
const personalSkills = Effect.fn('CapabilityCatalog.personalSkills')(function* (
	context: ToolExecutionContext
) {
	if (!context.toolNames.includes(PERSONAL_LIST_TOOL)) return [];
	return (yield* Schema.decodeUnknownEffect(PersonalList)(
		yield* executeHostTool(PERSONAL_LIST_TOOL, {}, context)
	).pipe(Effect.mapError((error) => invalidToolInput(PERSONAL_LIST_TOOL, error)))).skills;
});

/** A skill's `## ` headings, in order: the index a reader asks by. */
export const skillSections = (body: string): ReadonlyArray<string> =>
	[...body.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.trim());

/** One `## section` of a skill body by title (case-insensitive), or nothing. */
const skillSection = (body: string, title: string): string | undefined => {
	const wanted = title.trim().toLowerCase();
	const parts = body.split(/^(?=## )/m);
	return parts
		.find(
			(part) =>
				part
					.match(/^## (.+)$/m)?.[1]
					?.trim()
					.toLowerCase() === wanted
		)
		?.trimEnd();
};
const CompactInput = Schema.Struct({ reason: Schema.NonEmptyString });
/** Exact matches only: a filter is a field and the value it must equal. */
const CollectionFilterValue = Schema.Union([
	Schema.String,
	Schema.Number,
	Schema.Boolean,
	Schema.Null
]);
const CollectionReadInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(50)
		)
	),
	cursor: Schema.optionalKey(Schema.NonEmptyString),
	where: Schema.optionalKey(Schema.Record(Schema.String, CollectionFilterValue)),
	columns: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
});
const CollectionWriteInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	operation: Schema.Literals(['create', 'update', 'delete']),
	id: Schema.optionalKey(Schema.NonEmptyString),
	values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
});
const TaskHistoryInput = Schema.Struct({
	scope: Schema.optionalKey(Schema.Literals(['this_task', 'workbench', 'mine'])),
	query: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(50)
		)
	)
});

export type ToolExecutionContext = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	readonly agentId: string;
	readonly conversationId: ConversationId;
	readonly workbenchId: string;
	readonly skills: ReadonlyArray<SkillDeclaration>;
	readonly toolNames: ReadonlyArray<string>;
	readonly collectionNames: ReadonlyArray<string>;
	readonly readableCollectionNames: ReadonlyArray<string>;
	readonly writableCollectionNames: ReadonlyArray<string>;
	readonly workspace: Workspace.Interface;
	readonly collections: Collections.Interface;
	readonly hostTools: HostToolsInterface;
	readonly previousTodo?: TodoList;
}>;

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
	tool: string,
	schema: S,
	input: unknown
) =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError((error) => invalidToolInput(tool, error))
	);

/** The host's private-skill tools, reached through the one skill list and reader. */
export const PERSONAL_LIST_TOOL = 'list_personal_skills';
export const PERSONAL_READ_TOOL = 'read_personal_skill';
const PersonalList = Schema.Struct({
	skills: Schema.Array(
		Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) })
	)
});
const PersonalBody = Schema.Struct({ body: Schema.String });

export const READ_COLLECTION_RESULT_BYTE_LIMIT = 16 * 1024;

const serializedBytes = (value: Schema.Json): number => {
	const encoded = JSON.stringify(value);
	return encoded === undefined
		? Number.POSITIVE_INFINITY
		: new TextEncoder().encode(encoded).byteLength;
};

const defaultCollectionCursor = (row: Schema.Json | undefined): string | null =>
	row === undefined ? null : encodeCollectionCursor([{ column: 'id', direction: 'asc' }], row);

/**
 * The fields of one row, largest serialized value first.
 *
 * A read that returns nothing because its *first* row is oversized is otherwise a dead end: the
 * model cannot see which column is fat, and every retry reads it again. Naming the heaviest fields
 * is what turns the diagnostic into the next call's projection.
 */
const heaviestColumns = (
	row: Schema.Json | undefined,
	limit = 3
): ReadonlyArray<Readonly<{ column: string; bytes: number }>> => {
	if (row == null || typeof row !== 'object' || Array.isArray(row)) return [];
	return Object.entries(row)
		.flatMap(([column, value]) => {
			const encoded = JSON.stringify(value);
			return encoded === undefined
				? []
				: [{ column, bytes: new TextEncoder().encode(encoded).byteLength }];
		})
		.sort((left, right) => right.bytes - left.bytes)
		.slice(0, limit);
};

export const boundedCollectionReadResult = (
	fetchedRows: ReadonlyArray<Schema.Json>,
	requestedRows: number
): Schema.Json => {
	const pageRows = fetchedRows.slice(0, requestedRows);
	const providerHasMore = fetchedRows.length > requestedRows;
	const fullResult: Schema.Json = {
		rows: pageRows,
		truncated: false,
		rowCount: {
			requested: requestedRows,
			fetched: fetchedRows.length,
			page: pageRows.length,
			returned: pageRows.length,
			omitted: 0
		},
		cursor: {
			hasMore: providerHasMore,
			next:
				providerHasMore && pageRows.length > 0
					? defaultCollectionCursor(pageRows[pageRows.length - 1])
					: null
		},
		diagnostic: null
	};
	const originalBytes = serializedBytes(fullResult);
	if (originalBytes <= READ_COLLECTION_RESULT_BYTE_LIMIT) return fullResult;

	for (let count = pageRows.length - 1; count >= 0; count -= 1) {
		const omitted = pageRows.length - count;
		const hasMore = providerHasMore || omitted > 0;
		const result: Schema.Json = {
			rows: pageRows.slice(0, count),
			truncated: true,
			rowCount: {
				requested: requestedRows,
				fetched: fetchedRows.length,
				page: pageRows.length,
				returned: count,
				omitted
			},
			cursor: {
				hasMore,
				next: hasMore && count > 0 ? defaultCollectionCursor(pageRows[count - 1]) : null
			},
			diagnostic: {
				code: 'read_collection_result_truncated',
				reason:
					count === 0 && pageRows.length > 0
						? 'first-row-exceeds-serialized-byte-limit'
						: 'complete-row-prefix',
				byteLimit: READ_COLLECTION_RESULT_BYTE_LIMIT,
				originalBytes,
				...(count === 0 && pageRows.length > 0
					? { heaviestColumns: heaviestColumns(pageRows[0]) }
					: {})
			}
		};
		if (serializedBytes(result) <= READ_COLLECTION_RESULT_BYTE_LIMIT) return result;
	}
	throw new Error('Collection read metadata exceeds the serialized byte limit');
};

export const readSkillBody = Effect.fn('CapabilityCatalog.readSkillBody')(function* (
	skills: ReadonlyArray<SkillDeclaration>,
	name: string
) {
	const decodedName = yield* Schema.decodeUnknownEffect(SkillDeclaration.fields.name)(name).pipe(
		Effect.mapError(() => new SkillError({ name, reason: 'invalid-name' }))
	);
	const skill = skills.find((candidate) => candidate.name === decodedName);
	if (skill === undefined) return yield* new SkillError({ name: decodedName, reason: 'missing' });
	return skill.body;
});

/**
 * The workspace as one concise answer: what the collections are and how they are written, the
 * apps, the automations, the envoys and integrations — so a turn reads the shape once instead of
 * sampling rows to guess at columns. Every collection is the public API of a `+model.ts`; the
 * `note` says where the source lives for anyone with a file-reading tool.
 */
const WORKSPACE_NOTE =
	"Fields read name:type, then ! required, [] array, =a|b enum values, ->collection reference, (file) (files) (generated) (search). Source: src/collections/<name>/+model.ts and +collection.ts, src/collections/+relationship.ts, src/access/policies/+<name>.ts, src/access/+teams.ts, src/apps/+<name>.svelte, src/automations/+<name>.ts — read them with a file tool when this is not enough. write_collection takes the listed create/update columns and answers with the stored row; a refusal names the rule. read_collection answers within your policy scope and is complete: a short answer is the whole answer, not a hidden subset. id, created_at, updated_at, row_version are the platform's. personalSkills are what this person taught you earlier — read one with read_skill when a request uses its words.";

/** One field as a token: `customer_id:uuid!->customers`, `status:string=pending|done`. */
const describeField = (
	name: string,
	field: WorkspaceDefinition['collections'][number]['fields'][string],
	relations: ReadonlyArray<RelationDefinition>
): string => {
	const edge = relations.find((relation) => relation.from?.column === name);
	const targets =
		field.reference === undefined
			? edge === undefined
				? []
				: [edge.target]
			: field.reference.targets.map((target) => target.collection);
	return [
		`${name}:${field.type}`,
		field.required ? '!' : '',
		(field as { readonly array?: true }).array === true ? '[]' : '',
		field.values === undefined ? '' : `=${field.values.join('|')}`,
		targets.length === 0 ? '' : `->${targets.join('|')}`,
		field.file === true ? (field.fileMultiple === true ? '(files)' : '(file)') : '',
		field.search === true ? '(search)' : ''
	].join('');
};

const describeCollection = (
	collection: WorkspaceDefinition['collections'][number],
	definition: WorkspaceDefinition,
	readable: boolean,
	writable: boolean
): Schema.JsonObject => {
	const relations = definition.relations.filter((relation) => relation.source === collection.name);
	const write = collection.write;
	const columnsOf = (selection: CollectionInputSelection | undefined): string | null =>
		selection === undefined
			? null
			: [
					...Object.keys(selection.columns ?? {}),
					...Object.keys(selection.with ?? {}).map((relation) => `${relation}{…}`)
				].join(', ');
	const contract = (): Schema.JsonObject | null => {
		if (write === undefined) return null;
		const create = columnsOf(write.create);
		const update = columnsOf(write.update);
		return {
			...(create === null ? {} : { create }),
			...(update === null ? {} : { update }),
			...(write.delete === true ? { delete: true } : {}),
			...(write.hasTransform ? { transform: true } : {})
		};
	};
	const search = [
		...(collection.embedding === undefined ? [] : ['/semantic']),
		...(write?.similarity ?? []).map((index) => `/${index.name}`)
	];
	const integrations = definition.integrations
		.filter((integration) => integration.collection === collection.name)
		.map((integration) => integration.name);
	return {
		name: collection.name,
		...(collection.description === undefined ? {} : { description: collection.description }),
		...(collection.recordLabel === undefined ? {} : { label: collection.recordLabel }),
		fields: Object.entries(collection.fields)
			// The platform's own columns stay out: system, the search document, the embedding trio.
			.filter(
				([name]) =>
					!SYSTEM_COLUMN_NAMES.includes(name) &&
					name !== collection.search?.documentColumn &&
					name !== collection.embedding?.vectorColumn &&
					name !== collection.embedding?.embeddedAtColumn &&
					name !== collection.embedding?.sourceFingerprintColumn
			)
			.map(([name, field]) => describeField(name, field, relations)),
		write: contract(),
		...(search.length === 0 ? {} : { search }),
		...(integrations.length === 0 ? {} : { integrations })
	};
};

export const describeWorkspace = (
	context: Pick<
		ToolExecutionContext,
		| 'workspace'
		| 'collectionNames'
		| 'readableCollectionNames'
		| 'writableCollectionNames'
		| 'toolNames'
		| 'skills'
		| 'subject'
	>
): Schema.JsonObject => {
	const definition = context.workspace.definition;
	return {
		name: definition.name,
		version: definition.version,
		note: WORKSPACE_NOTE,
		collections: definition.collections
			.filter(({ name }) => context.collectionNames.includes(name))
			.map((collection) =>
				describeCollection(
					collection,
					definition,
					context.readableCollectionNames.includes(collection.name),
					context.writableCollectionNames.includes(collection.name)
				)
			),
		apps: definition.apps.map(
			(app) =>
				`${app.name}: ${app.label}${app.kiosk === true ? ' (kiosk)' : ''}${app.description === undefined ? '' : ` — ${app.description}`}`
		),
		automations: definition.automations.map(
			(automation) =>
				`${automation.name} [${
					automation.trigger._tag === 'Schedule'
						? `schedule ${automation.trigger.cron}`
						: automation.trigger._tag === 'Change'
							? `${automation.trigger.collection} ${automation.trigger.event}`
							: 'manual'
				}]${automation.description === undefined ? '' : ` — ${automation.description}`}`
		),
		// Who does what: the declared teams and the policies each holds, then the asker's own place.
		teams: Object.entries(definition.teams ?? {}).map(
			([team, policies]) => `${team}: ${policies.join(', ')}`
		),
		you:
			context.subject.system === true
				? 'system'
				: context.subject.policies.length === 0
					? 'admin (every collection, no policy scope)'
					: `teams ${context.subject.teamPath.join(' > ')}; policies ${context.subject.policies.join(', ')}`,
		envoys: definition.envoys.map((envoy) => envoy.name),
		integrations: definition.integrations.map(
			(integration) =>
				`${integration.name} on ${integration.collection} (${[
					integration.receive.length > 0 ? `${integration.receive.length} pull` : '',
					integration.webhooks.length > 0 ? `${integration.webhooks.length} webhook` : '',
					integration.send.length > 0 ? `${integration.send.length} send` : ''
				]
					.filter((part) => part !== '')
					.join(', ')})`
		),
		tools: context.toolNames,
		skills: context.skills.map(({ name: skill }) => skill)
	};
};

const TodoInput = Schema.Union([
	Schema.Struct({ operation: Schema.Literal('read') }),
	Schema.Struct({ operation: Schema.Literal('set'), items: Schema.Array(TodoItem) })
]);

/**
 * `read` answers the stored list; `set` validates a replacement against it.
 *
 * The previous list comes from the conversation row, not from walking the transcript for the newest
 * successful `todo` result. Same answer, one source, and the done-is-terminal rule below is checked
 * against what is actually stored rather than against whatever the scan happened to find.
 */
const validatedTodo = Effect.fn('CapabilityCatalog.validatedTodo')(function* (
	input: unknown,
	previous?: TodoList
) {
	const request = yield* decode('todo', TodoInput, input);
	if (request.operation === 'read') return previous ?? { items: [] };
	const next: TodoList = { items: request.items };
	if (next.items.length > 100) {
		return yield* new ToolNotAllowed({ agent: 'platform', tool: 'todo:item-limit' });
	}
	const ids = new Set<string>();
	let doing = 0;
	for (const item of next.items) {
		if (item.text.trim() === '' || ids.has(item.id)) {
			return yield* new ToolNotAllowed({ agent: 'platform', tool: 'todo:invalid-item' });
		}
		ids.add(item.id);
		if (item.status === 'doing') doing += 1;
		const prior = previous?.items.find(({ id }) => id === item.id);
		if (prior?.status === 'done' && (item.status !== 'done' || prior.text !== item.text)) {
			return yield* new ToolNotAllowed({ agent: 'platform', tool: 'todo:done-is-terminal' });
		}
	}
	if (doing > 1) {
		return yield* new ToolNotAllowed({ agent: 'platform', tool: 'todo:multiple-doing' });
	}
	return next;
});

/** The conversations a search may reach: this tree, or every one the person owns. */
const taskIdsIn = Effect.fn('CapabilityCatalog.taskIdsIn')(function* (
	context: ToolExecutionContext,
	scope: 'workbench' | 'mine'
) {
	const rows = yield* context.collections.findMany(context.effectId, context.subject, {
		collection: 'conversation',
		where:
			scope === 'workbench'
				? { workbench_id: { eq: context.workbenchId } }
				: { subject_id: { eq: context.subject.userId } },
		orderBy: { created_at: 'desc' },
		limit: 50
	});
	return (yield* decodeRows(TaskProjection, rows)).map(({ id }) => id);
});

/** Executes one system platform Tool. Effect Toolkit owns parameter/result encoding around it. */
export const executeSystemTool = Effect.fn('CapabilityCatalog.executeSystemTool')(function* (
	name: SystemToolName,
	input: unknown,
	context: ToolExecutionContext
) {
	switch (name) {
		case 'todo':
			return yield* validatedTodo(input, context.previousTodo);
		/**
		 * The tool records the intent; the turn's own loop performs the checkpoint.
		 *
		 * Compaction rewrites the projection the loop is about to send and needs the transcript, the
		 * active Plan and the retained-message set — all of which live in the loop, not in a tool
		 * handler. Deferring by one step also means the agent's remaining tool calls in this step
		 * still run and are summarized *into* the checkpoint rather than stranded after it.
		 *
		 * Nothing is signalled back through this context. The loop reads the calls it just executed
		 * and sees the `compact` among them, which is one fewer thing to keep in agreement than a
		 * callback threaded through three signatures to set a flag.
		 */
		case 'compact': {
			const parsed = yield* decode(name, CompactInput, input);
			return { checkpoint: 'scheduled', reason: parsed.reason };
		}
		case 'describe_workspace': {
			// The person's own skills ride on the answer every turn opens with, so a shorthand the
			// person taught is found without a listing call — and without touching the cached prompt.
			const personal = yield* personalSkills(context);
			return personal.length === 0
				? describeWorkspace(context)
				: {
						...describeWorkspace(context),
						personalSkills: personal.map(({ name: skill, description }) =>
							description === undefined ? skill : `${skill} — ${description}`
						)
					};
		}
		/**
		 * One list, one reader. A person's private skills live in the host, so they are folded in
		 * here when the host advertises them — the model never learns there are two stores.
		 */
		case 'list_skills': {
			const personal = yield* personalSkills(context);
			return {
				readTool: 'read_skill',
				skills: [
					...context.skills.map(({ name: skill, description, body }) => {
						const sections = skillSections(body);
						return {
							name: skill,
							...(description === undefined ? {} : { description }),
							...(sections.length === 0 ? {} : { sections })
						};
					}),
					...personal.map((skill) => ({ ...skill, scope: 'personal' as const }))
				]
			};
		}
		case 'read_skill': {
			const parsed = yield* decode(name, SkillNameInput, input);
			const own = context.skills.some((skill) => skill.name === parsed.name);
			if (!own && context.toolNames.includes(PERSONAL_READ_TOOL)) {
				const { body } = yield* Schema.decodeUnknownEffect(PersonalBody)(
					yield* executeHostTool(PERSONAL_READ_TOOL, { name: parsed.name }, context)
				).pipe(Effect.mapError((error) => invalidToolInput(PERSONAL_READ_TOOL, error)));
				const section = parsed.section === undefined ? body : skillSection(body, parsed.section);
				if (section === undefined)
					return yield* new SkillError({
						name: `${parsed.name} § ${parsed.section}`,
						reason: 'missing'
					});
				return { name: parsed.name, body: section, scope: 'personal' };
			}
			const body = yield* readSkillBody(context.skills, parsed.name);
			if (parsed.section === undefined) return { name: parsed.name, body };
			const section = skillSection(body, parsed.section);
			if (section === undefined)
				return yield* new SkillError({
					name: `${parsed.name} § ${parsed.section}`,
					reason: 'missing'
				});
			return { name: parsed.name, section: parsed.section, body: section };
		}
		case 'search_task_history': {
			const parsed = yield* decode(name, TaskHistoryInput, input);
			const scope = parsed.scope ?? 'this_task';
			const taskIds: ReadonlyArray<ConversationId> =
				scope === 'this_task' ? [context.conversationId] : yield* taskIdsIn(context, scope);
			const rows = yield* context.collections.findMany(context.effectId, context.subject, {
				collection: 'conversation_message',
				where: { conversation_id: { in: taskIds } },
				orderBy: { sequence: 'desc' },
				limit: 200
			});
			const query = parsed.query?.trim().toLocaleLowerCase();
			const limit = parsed.limit ?? 20;
			const messages = (yield* decodeRows(MessageProjection, rows))
				.filter(
					({ message }) =>
						query === undefined || messageText(message).toLocaleLowerCase().includes(query)
				)
				.slice(0, limit)
				.map(({ conversation_id, sequence, author, message }) => ({
					conversationId: conversation_id,
					sequence,
					author,
					message
				}));
			return { scope, messages };
		}
		case 'read_messages': {
			const parsed = yield* decode(
				name,
				Schema.Struct({
					limit: Schema.optionalKey(
						Schema.Number.check(
							Schema.isInt(),
							Schema.isGreaterThanOrEqualTo(1),
							Schema.isLessThanOrEqualTo(50)
						)
					)
				}),
				input
			);
			const inbox = yield* Effect.serviceOption(EnvoyInbox.Service);
			if (Option.isNone(inbox))
				return yield* new ToolNotAllowed({ agent: context.agentId, tool: name });
			const result = yield* inbox.value.read(
				context.effectId,
				context.conversationId,
				context.effectId,
				parsed.limit ?? 20
			);
			const floor = result.horizon.floorAt;
			return {
				messages: result.messages.map(
					({
						sent_at,
						sender_external_id,
						sender_display_name,
						invocation,
						text,
						attachments
					}) => ({
						sentAt: sent_at,
						...(sender_external_id === null ? {} : { senderId: sender_external_id }),
						...(sender_display_name === null ? {} : { senderName: sender_display_name }),
						invocation,
						text,
						attachments: attachments.map(({ key, fileName, mimeType, size, provider }) => ({
							...(key === undefined ? {} : { key }),
							name: fileName,
							mimeType,
							size,
							provider
						}))
					})
				),
				unreadAfter: result.unreadAfter,
				horizon: result.horizon,
				note: `Messages are shown as the channel last reported them; a sender may have edited or deleted one since. This chat history is visible from ${
					floor ?? 'the start of the recording'
				}${result.horizon.prePairing > 0 ? `, including ${result.horizon.prePairing} messages synced from before this tenant paired the account` : ''}. Earlier messages cannot be retrieved from this channel.`
			};
		}
		case 'use_image': {
			const asset = yield* decode(name, ImageAsset, input);
			return asset;
		}
		case 'read_collection': {
			const parsed = yield* decode(name, CollectionReadInput, input);
			if (!context.readableCollectionNames.includes(parsed.collection)) {
				return yield* new ToolNotAllowed({
					agent: context.agentId,
					tool: `read_collection:${parsed.collection}`
				});
			}
			const limit = parsed.limit ?? 50;
			/**
			 * The model's filter and projection, in the collection contract's own shapes: `where` is a
			 * field equalling a value, and `id` is always selected because the continuation cursor is
			 * encoded from it. The read policy still applies, so narrowing never widens a read.
			 */
			const where =
				parsed.where === undefined
					? undefined
					: Object.fromEntries(
							Object.entries(parsed.where).map(([field, value]) => [field, { eq: value }])
						);
			const columns =
				parsed.columns === undefined
					? undefined
					: { id: true, ...Object.fromEntries(parsed.columns.map((column) => [column, true])) };
			const rows = yield* context.collections.findMany(context.effectId, context.subject, {
				collection: parsed.collection,
				limit: limit + 1,
				after: parsed.cursor,
				...(where === undefined ? {} : { where }),
				...(columns === undefined ? {} : { columns })
			});
			return boundedCollectionReadResult(rows, limit);
		}
		case 'write_collection': {
			const parsed = yield* decode(name, CollectionWriteInput, input);
			if (!context.writableCollectionNames.includes(parsed.collection)) {
				return yield* new ToolNotAllowed({
					agent: context.agentId,
					tool: `write_collection:${parsed.collection}`
				});
			}
			if (parsed.operation !== 'create' && parsed.id === undefined)
				return yield* new ToolNotAllowed({
					agent: context.agentId,
					tool: `write_collection:${parsed.collection}:${parsed.operation} names no record`
				});
			const submitted =
				parsed.operation === 'delete'
					? { id: parsed.id }
					: { ...(parsed.values ?? {}), ...(parsed.id === undefined ? {} : { id: parsed.id }) };
			const commit = yield* context.collections.write(context.effectId, context.subject, [
				{ collection: parsed.collection, action: parsed.operation, inputs: [submitted] }
			]);
			const written = commit.records[0];
			// The stored row rides back, so a create or update is verified without a second read.
			const record =
				written === undefined || parsed.operation === 'delete'
					? undefined
					: (JSON.parse(JSON.stringify(written)) as Schema.Json);
			return {
				collection: parsed.collection,
				id: parsed.id ?? (isString(written?.['id']) ? written['id'] : ''),
				operation: parsed.operation,
				...(record === undefined ? {} : { record }),
				...(commit.pendingApproval === undefined ? {} : { pendingApproval: commit.pendingApproval })
			};
		}
		default: {
			const exhaustive: never = name;
			return exhaustive;
		}
	}
});

export const executeHostTool = Effect.fn('CapabilityCatalog.executeHostTool')(function* (
	name: string,
	input: Schema.Json,
	context: ToolExecutionContext
) {
	const call = context.hostTools.execute(EffectId.make(`${context.effectId}:host:${name}`), {
		tool: name,
		input,
		sessionId: context.conversationId
	});
	return (yield* context.subject.system !== true && context.subject.policies.length === 0
		? call.pipe(Effect.provideService(Identity.CurrentSubject, context.subject))
		: call).output;
});

export const SUBAGENT_TOOL_NAME = 'subagent';

/**
 * The `subagent` tool for one workspace. `spawnableAgentIds` is the closed set of agents a spawn
 * may name (the workspace's envoys plus the web agent), so the model reads it off the schema and an
 * invented name is a decode failure on `agentId` rather than an access refusal after the fact.
 */
export const subagentToolSpec = (spawnableAgentIds: ReadonlyArray<string>): ToolDeclaration => ({
	name: SUBAGENT_TOOL_NAME,
	description:
		"Run child Tasks in this workbench. spawn starts a child at once and returns its conversationId while it runs in the background — spawn several in one step to run them side by side, keep working, read for progress, message to steer (it lands at the child's next step), await (or wait) to collect its answer when you need it — bounded, so a long child is awaited again — or simply finish: a child that settles reports into this conversation and wakes you if you are idle; stop and resume to control it. read and message also reach any other conversation of this person (find one with search_task_history); a message to an idle conversation starts its next turn. Only the root Task may do this; children cannot delegate.",
	command: 'platform:subagent',
	inputSchema: objectInput(
		{
			action: {
				type: 'string',
				enum: ['spawn', 'read', 'message', 'await', 'stop', 'resume']
			},
			agentId: {
				type: 'string',
				enum: [...spawnableAgentIds],
				description: 'Required for spawn: one of the agents this workspace declares.'
			},
			instruction: { type: 'string', minLength: 1, description: 'Required for spawn.' },
			conversationId: {
				type: 'string',
				format: 'uuid',
				description: 'Required for every action except spawn.'
			},
			message: { type: 'string', minLength: 1, description: 'Required for message.' },
			timeoutSeconds: {
				type: 'integer',
				minimum: 1,
				maximum: 600,
				description: 'For await: how long to wait before answering with the child still running.'
			}
		},
		['action']
	)
});

const subagentAction = (spawnableAgentIds: ReadonlyArray<string>) =>
	Schema.Union([
		Schema.Struct({
			action: Schema.Literal('spawn'),
			agentId: Schema.Literals(spawnableAgentIds),
			instruction: Schema.NonEmptyString
		}),
		Schema.Struct({ action: Schema.Literal('read'), conversationId: ConversationId }),
		Schema.Struct({
			action: Schema.Literal('message'),
			conversationId: ConversationId,
			message: Schema.NonEmptyString
		}),
		Schema.Struct({
			action: Schema.Literal('await'),
			conversationId: ConversationId,
			timeoutSeconds: Schema.optionalKey(
				Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 }))
			)
		}),
		Schema.Struct({ action: Schema.Literal('stop'), conversationId: ConversationId }),
		Schema.Struct({ action: Schema.Literal('resume'), conversationId: ConversationId })
	]);

/**
 * What this file can fail with on its own: a malformed call, a target the caller may not reach.
 *
 * It used to be a five-member union ending in `| unknown`, which is `unknown` — the members were
 * decorative and every caller of a subagent action inherited an unresolvable error channel.
 */
type SubagentFailure =
	| Collections.QueryError
	| ToolNotAllowed
	| InvalidToolInput
	| InvocationBudget.NestingLimitExceeded;

/**
 * The runtime hooks a subagent action calls, parameterised by what the runtime can fail with.
 *
 * Generic rather than fixed, because these are implemented in `agents.ts` and fail with everything
 * a turn does — a set this file cannot name without importing the module that imports it.
 */
export type SubagentContext<E = never> = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	readonly workbenchId: WorkbenchId;
	readonly agentId: AgentId;
	readonly conversationId: ConversationId;
	/** True when this conversation is itself a child Task: a child may coordinate but not spawn. */
	readonly isChild: boolean;
	/** The agents a spawn may name; the same set the tool's schema advertised. */
	readonly spawnableAgentIds: ReadonlyArray<string>;
	readonly collections: Collections.Interface;
	readonly budget: InvocationBudget.Interface;
	readonly spawn: (
		effectId: EffectId,
		agentId: AgentId,
		instruction: string,
		depth: number,
		toolCallId: string
	) => Effect.Effect<Schema.Json, E>;
	readonly admit: (
		effectId: EffectId,
		conversationId: ConversationId,
		message: string
	) => Effect.Effect<Schema.Json, E>;
	readonly awaitTarget: (
		effectId: EffectId,
		conversationId: ConversationId,
		timeoutSeconds: number | undefined
	) => Effect.Effect<Schema.Json, E>;
	readonly control: (
		effectId: EffectId,
		conversationId: ConversationId,
		action: 'stop' | 'resume'
	) => Effect.Effect<Schema.Json, E>;
}>;

/**
 * Who a subagent action may reach. `child`: a direct child (stop, resume). `workbench`: any
 * conversation of this tree (await). `own`: also any
 * other conversation of the same person — read and message, so two of a person's conversations
 * can talk; a message to an idle one starts its next turn, to a running one steers it.
 */
const workbenchTask = Effect.fn('CapabilityCatalog.workbenchTask')(function* (
	context: SubagentContext<unknown>,
	targetId: ConversationId,
	reach: 'child' | 'workbench' | 'own'
) {
	const rows = yield* context.collections.findMany(context.effectId, context.subject, {
		collection: 'conversation',
		where: { id: { in: [context.conversationId, targetId] } },
		limit: 2
	});
	const tasks = yield* decodeRows(TaskProjection, rows);
	const current = tasks.find(({ id }) => id === context.conversationId);
	const target = tasks.find(({ id }) => id === targetId);
	const sameWorkbench =
		current?.workbench_id === context.workbenchId && target?.workbench_id === context.workbenchId;
	const allowed =
		reach === 'child'
			? sameWorkbench && target?.parent_id === context.conversationId
			: reach === 'workbench'
				? sameWorkbench
				: sameWorkbench || target?.subject_id === context.subject.userId;
	if (current === undefined || target === undefined || !allowed) {
		return yield* new ToolNotAllowed({ agent: context.agentId, tool: 'subagent:aperture' });
	}
	return target;
});

export const executeSubagentTool = Effect.fn('CapabilityCatalog.executeSubagentTool')(function* <E>(
	input: unknown,
	context: SubagentContext<E>,
	toolCallId: string
) {
	const action = yield* Schema.decodeUnknownEffect(subagentAction(context.spawnableAgentIds))(
		input
	).pipe(Effect.mapError((error) => invalidToolInput(SUBAGENT_TOOL_NAME, error)));
	switch (action.action) {
		case 'spawn': {
			// A child Task must not spawn its own children: the lineage is exactly one level deep. The
			// per-invocation nesting budget resets when a child runs its own turn, so the durable parent
			// link carried on the context is the cap.
			if (context.isChild)
				return yield* new ToolNotAllowed({
					agent: context.agentId,
					tool: 'subagent:child-cannot-spawn'
				});
			const depth = yield* context.budget.nest(`child of ${context.agentId}`);
			return yield* context.spawn(
				context.effectId,
				AgentId.make(action.agentId),
				action.instruction,
				depth,
				toolCallId
			);
		}
		case 'read': {
			const target = yield* workbenchTask(context, action.conversationId, 'own');
			const rows = yield* context.collections.findMany(context.effectId, context.subject, {
				collection: 'conversation_message',
				where: { conversation_id: { eq: target.id } },
				orderBy: { sequence: 'asc' },
				limit: 200
			});
			const messages = yield* decodeRows(MessageProjection, rows);
			return {
				conversationId: target.id,
				agentId: target.agent_id,
				status: target.status,
				messages: messages.map(({ sequence, author, message }) => ({ sequence, author, message }))
			};
		}
		case 'message':
			yield* workbenchTask(context, action.conversationId, 'own');
			return yield* context.admit(context.effectId, action.conversationId, action.message);
		case 'await':
			yield* workbenchTask(context, action.conversationId, 'workbench');
			return yield* context.awaitTarget(
				context.effectId,
				action.conversationId,
				action.timeoutSeconds
			);
		case 'stop':
		case 'resume':
			yield* workbenchTask(context, action.conversationId, 'child');
			return yield* context.control(context.effectId, action.conversationId, action.action);
	}
});

export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;
const McpCallToolResult = withInputRequired(specTypeSchemas.CallToolResult);
type McpCallToolResult = CompleteCallToolResult | InputRequiredResult;
type McpFailureReason = McpToolError['reason'];
class McpAdapterFailure extends Error {
	readonly reason: McpFailureReason;
	constructor(reason: McpFailureReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

const toolError = (cause: unknown, route: McpToolRoute): McpToolError => {
	const reason =
		cause instanceof McpAdapterFailure
			? cause.reason
			: cause instanceof SdkHttpError
				? 'http-status'
				: cause instanceof ProtocolError
					? 'protocol-error'
					: 'invalid-response';
	const detail =
		cause instanceof SdkHttpError
			? `MCP server returned HTTP ${cause.status}: ${cause.message}`
			: getErrorMessage(cause);
	return new McpToolError({ server: route.server, tool: route.tool, reason, detail });
};

const responseBody = (status: number, headers: Headers, body: Schema.Json): BodyInit | null => {
	if (status === 204 || status === 205 || status === 304) return null;
	const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
	if (contentType === 'text/event-stream') {
		throw new McpAdapterFailure(
			'invalid-response',
			'The connector cannot represent MCP subscription streams.'
		);
	}
	return contentType === 'application/json' ||
		contentType?.endsWith('+json') === true ||
		!isString(body)
		? JSON.stringify(body)
		: body;
};

const connectorFetch = (
	route: McpToolRoute,
	effectId: EffectIdType,
	connector: ConnectorInterface,
	context: EffectContext<never>
): FetchLike => {
	let roundTrip = 0;
	return async (url, init) => {
		if ((init?.method?.toUpperCase() ?? 'GET') !== 'POST' || !isString(init?.body)) {
			throw new McpAdapterFailure(
				'protocol-error',
				'The host connector accepts only stateless MCP JSON POST requests.'
			);
		}
		const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(init.body);
		const response = await Effect.runPromiseWith(context)(
			connector.execute(EffectId.make(`${effectId}:mcp:${roundTrip++}`), {
				connector: route.server,
				operation: INTEGRATION_HTTP_OPERATION,
				input: {
					method: 'POST',
					url: isString(url) ? url : url.toString(),
					headers: Object.fromEntries(new Headers(init.headers)),
					body
				}
			}),
			init.signal === undefined || init.signal === null ? undefined : { signal: init.signal }
		);
		const decoded = Schema.decodeUnknownExit(IntegrationHttpResponse)(response.output);
		if (decoded._tag === 'Failure')
			throw new McpAdapterFailure(
				'invalid-response',
				'The connector returned an invalid HTTP response.'
			);
		const headers = new Headers(decoded.value.headers);
		return new Response(responseBody(decoded.value.status, headers, decoded.value.body), {
			status: decoded.value.status,
			headers
		});
	};
};

const closeMcp = (client: Client, transport: StreamableHTTPClientTransport) =>
	Effect.tryPromise({
		try: async () => {
			await client.close();
			await transport.close();
		},
		catch: toError
	});

export const callMcpTool = Effect.fn('CapabilityCatalog.callMcpTool')(function* (
	route: McpToolRoute,
	input: Schema.Json,
	effectId: EffectIdType,
	connector: ConnectorInterface
) {
	const context = yield* Effect.context<never>();
	return yield* Effect.acquireUseRelease(
		Effect.sync(() => {
			const client = new Client(
				{ name: '@norbital-ai/bolt', version: MCP_PROTOCOL_VERSION },
				{
					enforceStrictCapabilities: true,
					inputRequired: { autoFulfill: false },
					versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } }
				}
			);
			const transport = new StreamableHTTPClientTransport(new URL(route.url), {
				fetch: connectorFetch(route, effectId, connector, context)
			});
			return { client, transport };
		}),
		({ client, transport }) =>
			Effect.tryPromise({
				try: async (signal) => {
					const parameters = specTypeSchemas.CallToolRequestParams['~standard'].validate({
						name: route.tool,
						arguments: input
					});
					if (parameters.issues !== undefined) {
						const detail = parameters.issues
							.map((issue: StandardSchemaV1.Issue) => issue.message)
							.join('; ');
						throw new McpAdapterFailure(
							'invalid-input',
							detail || 'MCP tool arguments are invalid.'
						);
					}
					await client.connect(transport, { signal });
					return client.request(
						{ method: 'tools/call', params: parameters.value },
						McpCallToolResult,
						{ allowInputRequired: true, signal }
					);
				},
				catch: (cause) => toolError(cause, route)
			}),
		({ client, transport }) => closeMcp(client, transport)
	);
});
