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
import { Effect, Schema } from 'effect';
import type { Context as EffectContext } from 'effect/Context';
import { Prompt } from 'effect/unstable/ai';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { AgentId, ImageAsset, TaskId, WorkbenchId } from '@norbital-ai/bolt-protocol/facilities';
import { getErrorMessage, toError } from '@norbital-ai/std';
import {
	SkillDeclaration,
	type McpToolRoute,
	type ToolDeclaration,
	type WorkspaceDefinition
} from '#lib/authoring/workspace-schema.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { encodeCollectionCursor } from '#lib/runtime/collections/read/cursor.js';
import type { ConnectorInterface, HostToolsInterface } from '#lib/runtime/facilities/services.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import {
	INTEGRATION_HTTP_OPERATION,
	IntegrationHttpResponse
} from '#lib/runtime/integrations/http.js';

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
	id: TaskId,
	workbench_id: WorkbenchId,
	agent_id: AgentId,
	parent_id: Schema.optionalKey(Schema.NullOr(TaskId)),
	status: Schema.NonEmptyString
});
const MessageProjection = Schema.Struct({
	task_id: TaskId,
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
	typeof message.content === 'string'
		? message.content
		: message.content
				.flatMap((part) => (part.type === 'text' || part.type === 'reasoning' ? [part.text] : []))
				.join('\n');

const SystemToolNames = Schema.Literals([
	'todo',
	'describe_workspace',
	'list_skills',
	'read_skill',
	'search_task_history',
	'use_image',
	'read_collection',
	'write_collection'
]);
type SystemToolName = Schema.Schema.Type<typeof SystemToolNames>;

export const isSystemTool = Schema.is(SystemToolNames);

const objectInput = (
	properties: Schema.JsonObject,
	required: ReadonlyArray<string> = []
): Schema.JsonObject => ({
	type: 'object',
	properties,
	required: [...required],
	additionalProperties: false
});

export const systemToolSpecs: ReadonlyArray<ToolDeclaration> = [
	{
		name: 'todo',
		description:
			'Replace the current ordered Todo checklist. Stable IDs reconcile progress; Todo is evidence, not completion authority.',
		command: 'platform:todo',
		inputSchema: objectInput(
			{
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
			['items']
		)
	},
	{
		name: 'describe_workspace',
		description: 'Describe the workspace surface authorized for this run.',
		command: 'platform:describe_workspace'
	},
	{
		name: 'list_skills',
		description: 'List Skills authorized for this run.',
		command: 'platform:list_skills'
	},
	{
		name: 'read_skill',
		description: 'Read one authorized Skill body.',
		command: 'platform:read_skill',
		inputSchema: objectInput({ name: { type: 'string', minLength: 1 } }, ['name'])
	},
	{
		name: 'search_task_history',
		description:
			'Search complete durable Effect messages in this Task or its workbench. Task IDs define the boundary.',
		command: 'platform:search_task_history',
		inputSchema: objectInput({
			scope: { type: 'string', enum: ['this_task', 'workbench'] },
			query: { type: 'string' },
			limit: { type: 'integer', minimum: 1, maximum: 50 }
		})
	},
	{
		name: 'use_image',
		description:
			'Admit one descriptor-sized image source for the next provider call. The trusted host resolves and verifies bytes.',
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
		description: 'Read a bounded page from an authorized collection.',
		command: 'platform:read_collection',
		inputSchema: objectInput(
			{
				collection: { type: 'string', minLength: 1 },
				limit: { type: 'integer', minimum: 1, maximum: 50 },
				cursor: { type: 'string', minLength: 1 }
			},
			['collection']
		)
	},
	{
		name: 'write_collection',
		description: 'Create, update, or delete an authorized collection record.',
		command: 'platform:write_collection'
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

const SkillNameInput = Schema.Struct({ name: Schema.NonEmptyString });
const CollectionReadInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(50)
		)
	),
	cursor: Schema.optionalKey(Schema.NonEmptyString)
});
const CollectionWriteInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	operation: Schema.Literals(['create', 'update', 'delete']),
	id: Schema.NonEmptyString,
	values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
});
const TaskHistoryInput = Schema.Struct({
	scope: Schema.optionalKey(Schema.Literals(['this_task', 'workbench'])),
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
	readonly taskId: TaskId;
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

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(() => new ToolNotAllowed({ agent: 'platform', tool: 'invalid-input' }))
	);

export const READ_COLLECTION_RESULT_BYTE_LIMIT = 16 * 1024;

const serializedBytes = (value: Schema.Json): number => {
	const encoded = JSON.stringify(value);
	return encoded === undefined
		? Number.POSITIVE_INFINITY
		: new TextEncoder().encode(encoded).byteLength;
};

const defaultCollectionCursor = (row: Schema.Json | undefined): string | null =>
	row === undefined ? null : encodeCollectionCursor([{ column: 'id', direction: 'asc' }], row);

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
				originalBytes
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

const DescribeWorkspaceResult = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	collections: Schema.Array(Schema.String),
	apps: Schema.Array(Schema.String),
	tools: Schema.Array(Schema.String),
	skills: Schema.Array(Schema.String),
	automations: Schema.Array(Schema.String),
	envoys: Schema.Array(Schema.String),
	integrations: Schema.Array(Schema.String)
});
type DescribeWorkspaceResult = Schema.Schema.Type<typeof DescribeWorkspaceResult>;

const declaredSurface = (
	definition: WorkspaceDefinition
): Omit<DescribeWorkspaceResult, 'tools' | 'skills' | 'collections'> => ({
	name: definition.name,
	version: definition.version,
	apps: definition.apps.map((app) => app.name),
	automations: definition.automations.map((automation) => automation.name),
	envoys: definition.envoys.map((envoy) => envoy.name),
	integrations: definition.integrations.map((integration) => integration.name)
});

const validatedTodo = Effect.fn('CapabilityCatalog.validatedTodo')(function* (
	input: unknown,
	previous?: TodoList
) {
	const next = yield* decode(TodoList, input);
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

const taskIdsInWorkbench = Effect.fn('CapabilityCatalog.taskIdsInWorkbench')(function* (
	context: ToolExecutionContext
) {
	const rows = yield* context.collections.findMany(context.effectId, context.subject, {
		collection: 'agent_task',
		where: { workbench_id: { eq: context.workbenchId } },
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
		case 'describe_workspace':
			return {
				...declaredSurface(context.workspace.definition),
				collections: context.collectionNames,
				tools: context.toolNames,
				skills: context.skills.map(({ name: skill }) => skill)
			} satisfies DescribeWorkspaceResult;
		case 'list_skills':
			return { skills: context.skills.map(({ name: skill }) => skill) };
		case 'read_skill': {
			const parsed = yield* decode(SkillNameInput, input);
			const body = yield* readSkillBody(context.skills, parsed.name);
			return { name: parsed.name, body };
		}
		case 'search_task_history': {
			const parsed = yield* decode(TaskHistoryInput, input);
			const scope = parsed.scope ?? 'this_task';
			let taskIds: ReadonlyArray<TaskId> = [context.taskId];
			if (scope === 'workbench') taskIds = yield* taskIdsInWorkbench(context);
			const rows = yield* context.collections.findMany(context.effectId, context.subject, {
				collection: 'agent_message',
				where: { task_id: { in: taskIds } },
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
				.map(({ task_id, sequence, author, message }) => ({
					taskId: task_id,
					sequence,
					author,
					message
				}));
			return { scope, messages };
		}
		case 'use_image': {
			const asset = yield* decode(ImageAsset, input);
			return asset;
		}
		case 'read_collection': {
			const parsed = yield* decode(CollectionReadInput, input);
			if (!context.readableCollectionNames.includes(parsed.collection)) {
				return yield* new ToolNotAllowed({
					agent: context.agentId,
					tool: `read_collection:${parsed.collection}`
				});
			}
			const limit = parsed.limit ?? 50;
			const rows = yield* context.collections.findMany(context.effectId, context.subject, {
				collection: parsed.collection,
				limit: limit + 1,
				after: parsed.cursor
			});
			return boundedCollectionReadResult(rows, limit);
		}
		case 'write_collection': {
			const parsed = yield* decode(CollectionWriteInput, input);
			if (!context.writableCollectionNames.includes(parsed.collection)) {
				return yield* new ToolNotAllowed({
					agent: context.agentId,
					tool: `write_collection:${parsed.collection}`
				});
			}
			if (parsed.operation === 'delete') {
				yield* context.collections.delete(context.effectId, context.subject, parsed.collection, [
					parsed.id
				]);
			} else {
				yield* context.collections.mutate(
					context.effectId,
					context.subject,
					parsed.collection,
					[{ ...(parsed.values ?? {}), id: parsed.id }],
					false,
					0,
					{ roots: [{ id: parsed.id, action: parsed.operation }] }
				);
			}
			return { collection: parsed.collection, id: parsed.id, operation: parsed.operation };
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
	return (yield* context.hostTools.execute(EffectId.make(`${context.effectId}:host:${name}`), {
		tool: name,
		input
	})).output;
});

export const subagentToolSpec: ToolDeclaration = {
	name: 'subagent',
	description:
		'Coordinate bounded child Tasks in this workbench through spawn, read, message, await, steer, stop, and resume.',
	command: 'platform:subagent',
	inputSchema: {
		oneOf: [
			objectInput(
				{
					action: { const: 'spawn' },
					agentId: { type: 'string', minLength: 1 },
					instruction: { type: 'string', minLength: 1 }
				},
				['action', 'agentId', 'instruction']
			),
			objectInput({ action: { const: 'read' }, taskId: { type: 'string', format: 'uuid' } }, [
				'action',
				'taskId'
			]),
			...(['message', 'steer'] as const).map((action) =>
				objectInput(
					{
						action: { const: action },
						taskId: { type: 'string', format: 'uuid' },
						message: { type: 'string', minLength: 1 }
					},
					['action', 'taskId', 'message']
				)
			),
			...(['await', 'stop', 'resume'] as const).map((action) =>
				objectInput({ action: { const: action }, taskId: { type: 'string', format: 'uuid' } }, [
					'action',
					'taskId'
				])
			)
		]
	}
};

const SubagentAction = Schema.Union([
	Schema.Struct({
		action: Schema.Literal('spawn'),
		agentId: AgentId,
		instruction: Schema.NonEmptyString
	}),
	Schema.Struct({ action: Schema.Literal('read'), taskId: TaskId }),
	Schema.Struct({
		action: Schema.Literal('message'),
		taskId: TaskId,
		message: Schema.NonEmptyString
	}),
	Schema.Struct({ action: Schema.Literal('await'), taskId: TaskId }),
	Schema.Struct({
		action: Schema.Literal('steer'),
		taskId: TaskId,
		message: Schema.NonEmptyString
	}),
	Schema.Struct({ action: Schema.Literal('stop'), taskId: TaskId }),
	Schema.Struct({ action: Schema.Literal('resume'), taskId: TaskId })
]);

type SubagentFailure =
	| Collections.QueryError
	| Collections.MutationError
	| Collections.BatchMutationError
	| ToolNotAllowed
	| InvocationBudget.NestingLimitExceeded
	| unknown;
export type SubagentContext = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	readonly workbenchId: WorkbenchId;
	readonly agentId: AgentId;
	readonly taskId: TaskId;
	readonly collections: Collections.Interface;
	readonly budget: InvocationBudget.Interface;
	readonly spawn: (
		effectId: EffectId,
		agentId: AgentId,
		instruction: string,
		depth: number,
		toolCallId: string
	) => Effect.Effect<Schema.Json, SubagentFailure>;
	readonly admit: (
		effectId: EffectId,
		taskId: TaskId,
		message: string,
		priority: 'normal' | 'steer'
	) => Effect.Effect<Schema.Json, SubagentFailure>;
	readonly awaitTarget: (
		effectId: EffectId,
		taskId: TaskId
	) => Effect.Effect<Schema.Json, SubagentFailure>;
	readonly control: (
		effectId: EffectId,
		taskId: TaskId,
		action: 'stop' | 'resume'
	) => Effect.Effect<Schema.Json, SubagentFailure>;
}>;

const workbenchTask = Effect.fn('CapabilityCatalog.workbenchTask')(function* (
	context: SubagentContext,
	targetId: TaskId,
	requireDirectChild: boolean
) {
	const rows = yield* context.collections.findMany(context.effectId, context.subject, {
		collection: 'agent_task',
		where: { id: { in: [context.taskId, targetId] } },
		limit: 2
	});
	const tasks = yield* decodeRows(TaskProjection, rows);
	const current = tasks.find(({ id }) => id === context.taskId);
	const target = tasks.find(({ id }) => id === targetId);
	if (
		current === undefined ||
		target === undefined ||
		current.workbench_id !== context.workbenchId ||
		target.workbench_id !== context.workbenchId ||
		(requireDirectChild && target.parent_id !== context.taskId)
	) {
		return yield* new ToolNotAllowed({ agent: context.agentId, tool: 'subagent:aperture' });
	}
	return target;
});

export const executeSubagentTool = Effect.fn('CapabilityCatalog.executeSubagentTool')(function* (
	input: unknown,
	context: SubagentContext,
	toolCallId: string
) {
	const action = yield* Schema.decodeUnknownEffect(SubagentAction)(input).pipe(
		Effect.mapError(() => new ToolNotAllowed({ agent: 'subagent', tool: 'invalid-input' }))
	);
	switch (action.action) {
		case 'spawn': {
			const depth = yield* context.budget.nest(`child of ${context.agentId}`);
			return yield* context.spawn(
				context.effectId,
				action.agentId,
				action.instruction,
				depth,
				toolCallId
			);
		}
		case 'read': {
			const target = yield* workbenchTask(context, action.taskId, false);
			const rows = yield* context.collections.findMany(context.effectId, context.subject, {
				collection: 'agent_message',
				where: { task_id: { eq: target.id } },
				orderBy: { sequence: 'asc' },
				limit: 200
			});
			const messages = yield* decodeRows(MessageProjection, rows);
			return {
				taskId: target.id,
				agentId: target.agent_id,
				status: target.status,
				messages: messages.map(({ sequence, author, message }) => ({ sequence, author, message }))
			};
		}
		case 'message':
		case 'steer':
			yield* workbenchTask(context, action.taskId, false);
			return yield* context.admit(
				context.effectId,
				action.taskId,
				action.message,
				action.action === 'steer' ? 'steer' : 'normal'
			);
		case 'await':
			yield* workbenchTask(context, action.taskId, false);
			return yield* context.awaitTarget(context.effectId, action.taskId);
		case 'stop':
		case 'resume':
			yield* workbenchTask(context, action.taskId, true);
			return yield* context.control(context.effectId, action.taskId, action.action);
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
		typeof body !== 'string'
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
		if ((init?.method?.toUpperCase() ?? 'GET') !== 'POST' || typeof init?.body !== 'string') {
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
					url: typeof url === 'string' ? url : url.toString(),
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
