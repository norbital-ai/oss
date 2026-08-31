import { Effect, Schema } from 'effect';
import { asc, eq, inArray } from 'drizzle-orm';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { ToolDeclaration } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import { ToolNotAllowed } from '#lib/runtime/agents/agent-errors.js';
import type { DelegatedMessage } from '#lib/runtime/agents/agent-runtime.js';
import * as InvocationBudget from '#lib/runtime/budget.js';

const { chat_session: chatSession, chat_message: chatMessage } = SYSTEM_MODEL_TABLES;

const sandboxToolNames = [
	'spawn_agent',
	'list_agents',
	'read_agent',
	'message_agent',
	'await_agent',
	'steer_agent',
	'stop_agent',
	'resume_agent'
] as const;
const SandboxToolNames = Schema.Literals([...sandboxToolNames]);
type SandboxToolName = Schema.Schema.Type<typeof SandboxToolNames>;

export const isSandboxTool = Schema.is(SandboxToolNames);

const objectInput = (
	properties: Schema.JsonObject,
	required: ReadonlyArray<string> = []
): Schema.JsonObject => ({
	type: 'object',
	properties,
	required: [...required],
	additionalProperties: false
});
const agentIdInput = objectInput({ agentId: { type: 'string', minLength: 1 } }, ['agentId']);

export const sandboxToolSpecs: ReadonlyArray<ToolDeclaration> = [
	{
		name: 'spawn_agent',
		description: 'Spawn a direct child agent. The child may spawn its own children.',
		command: 'platform:spawn_agent',
		inputSchema: objectInput({ task: { type: 'string', minLength: 1 } }, ['task'])
	},
	{
		name: 'list_agents',
		description: 'List every agent spawned in this workbench.',
		command: 'platform:list_agents',
		inputSchema: objectInput({})
	},
	{
		name: 'read_agent',
		description: 'Read another agent transcript from this workbench.',
		command: 'platform:read_agent',
		inputSchema: agentIdInput
	},
	{
		name: 'message_agent',
		description: 'Pass a message to another agent in this workbench.',
		command: 'platform:message_agent',
		inputSchema: objectInput(
			{
				agentId: { type: 'string', minLength: 1 },
				message: { type: 'string', minLength: 1 }
			},
			['agentId', 'message']
		)
	},
	{
		name: 'await_agent',
		description: 'Run and wait for one exact task owned by an agent in this workbench.',
		command: 'platform:await_agent',
		inputSchema: objectInput(
			{
				agentId: { type: 'string', minLength: 1 },
				taskId: { type: 'string', minLength: 1 }
			},
			['agentId', 'taskId']
		)
	},
	...(['steer_agent', 'stop_agent', 'resume_agent'] as const).map((name): ToolDeclaration => ({
		name,
		description:
			name === 'steer_agent'
				? 'Send urgent guidance to another agent in this workbench for its next safe boundary.'
				: name === 'stop_agent'
					? 'Stop a direct child agent at its next facility boundary.'
					: 'Replay one stopped task as a fresh invocation.',
		command: `platform:${name}`,
		inputSchema:
			name === 'steer_agent'
				? objectInput(
						{
							agentId: { type: 'string', minLength: 1 },
							message: { type: 'string', minLength: 1 }
						},
						['agentId', 'message']
					)
				: agentIdInput
	}))
];

type SandboxActionFailure =
	Database.FacilityError | ToolNotAllowed | InvocationBudget.NestingLimitExceeded;
type SandboxAction = (
	effectId: EffectId,
	input: Schema.Json
) => Effect.Effect<Schema.Json, SandboxActionFailure>;

type SandboxContext = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	readonly workbenchKey: string;
	readonly agentName: string;
	readonly conversationId: string;
	readonly database: Database.Interface;
	readonly budget: InvocationBudget.Interface;
	readonly spawn: SandboxAction;
	readonly admit: SandboxAction;
	/** Runs or joins one exact child task and returns only after its assistant row settles. */
	readonly awaitTarget: SandboxAction;
	readonly stop: SandboxAction;
	readonly resume: SandboxAction;
}>;

const EmptyInput = Schema.Struct({});
const TaskInput = Schema.Struct({ task: Schema.NonEmptyString });
const AgentInput = Schema.Struct({ agentId: Schema.NonEmptyString });
const MessageInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	message: Schema.NonEmptyString
});
const AwaitInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
const NullableString = Schema.Union([Schema.String, Schema.Null]);
const AgentRow = Schema.Struct({
	conversation_id: Schema.String,
	parent_id: NullableString,
	sandbox_key: Schema.String,
	agent_name: Schema.String,
	title: NullableString
});
type AgentRow = Schema.Schema.Type<typeof AgentRow>;
const decodeAgentRow = Schema.decodeUnknownOption(AgentRow);
const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(() => new ToolNotAllowed({ agent: 'sandbox', tool: 'invalid-input' }))
	);

const agentView = (row: AgentRow) => ({
	agentId: row.conversation_id,
	agentName: row.agent_name,
	title: row.title
});

const workbenchAgent = Effect.fn('Agents.workbenchAgent')(function* (
	context: SandboxContext,
	targetId: string,
	requireChild = false
) {
	const result = yield* executeBuilt(
		context.effectId,
		context.database,
		composer
			.select({
				conversation_id: chatSession.conversation_id,
				parent_id: chatSession.parent_id,
				sandbox_key: chatSession.sandbox_key,
				agent_name: chatSession.agent_name,
				title: chatSession.title
			})
			.from(chatSession)
			.where(inArray(chatSession.conversation_id, [context.conversationId, targetId]))
	);
	const rows = result.rows.flatMap((row) => {
		const decoded = decodeAgentRow(row);
		return decoded._tag === 'Some' ? [decoded.value] : [];
	});
	const current = rows.find(({ conversation_id }) => conversation_id === context.conversationId);
	const target = rows.find(({ conversation_id }) => conversation_id === targetId);
	const child = target?.parent_id === context.conversationId;
	if (
		current === undefined ||
		target === undefined ||
		current.sandbox_key !== context.workbenchKey ||
		target.sandbox_key !== context.workbenchKey ||
		(requireChild && !child)
	) {
		return yield* new ToolNotAllowed({ agent: context.agentName, tool: 'agent-aperture' });
	}
	return target;
});

const ownTitle = Effect.fn('Agents.ownTitle')(function* (context: SandboxContext) {
	const result = yield* executeBuilt(
		EffectId.make(`${context.effectId}:sender`),
		context.database,
		composer
			.select({ title: chatSession.title })
			.from(chatSession)
			.where(eq(chatSession.conversation_id, context.conversationId))
			.limit(1)
	);
	const decoded = Schema.decodeUnknownOption(
		Schema.Struct({ title: Schema.optionalKey(NullableString) })
	)(result.rows[0]);
	return decoded._tag === 'Some' ? (decoded.value.title ?? null) : null;
});

/** Coordinates one workbench communication aperture; durable task rows are its only state. */
export const executeSandboxTool = Effect.fn('Agents.executeSandboxTool')(function* (
	name: SandboxToolName,
	input: Schema.Json,
	context: SandboxContext
) {
	switch (name) {
		case 'spawn_agent': {
			const parsed = yield* decode(TaskInput, input);
			const depth = yield* context.budget.nest(`child of ${context.agentName}`);
			return yield* context.spawn(context.effectId, { task: parsed.task, depth });
		}
		case 'list_agents': {
			yield* decode(EmptyInput, input);
			const result = yield* executeBuilt(
				context.effectId,
				context.database,
				composer
					.select({
						conversation_id: chatSession.conversation_id,
						parent_id: chatSession.parent_id,
						sandbox_key: chatSession.sandbox_key,
						agent_name: chatSession.agent_name,
						title: chatSession.title
					})
					.from(chatSession)
					.where(eq(chatSession.sandbox_key, context.workbenchKey))
			);
			const agents = result.rows.flatMap((row) => {
				const decoded = decodeAgentRow(row);
				return decoded._tag === 'Some' && decoded.value.conversation_id !== context.conversationId
					? [decoded.value]
					: [];
			});
			return { workbenchKey: context.workbenchKey, agents: agents.map(agentView) };
		}
		case 'read_agent': {
			const parsed = yield* decode(AgentInput, input);
			yield* workbenchAgent(context, parsed.agentId);
			const result = yield* executeBuilt(
				context.effectId,
				context.database,
				composer
					.select({ role: chatMessage.role, content: chatMessage.search_text })
					.from(chatMessage)
					.where(eq(chatMessage.conversation_id, parsed.agentId))
					.orderBy(asc(chatMessage.sequence))
			);
			return { agentId: parsed.agentId, messages: result.rows };
		}
		case 'message_agent': {
			const parsed = yield* decode(MessageInput, input);
			const target = yield* workbenchAgent(context, parsed.agentId);
			const title = yield* ownTitle(context);
			const depth = yield* context.budget.nest(`message from ${context.agentName}`);
			const message: DelegatedMessage = {
				from: {
					agentId: context.conversationId,
					agentName: context.agentName,
					title
				},
				text: parsed.message
			};
			return yield* context.admit(context.effectId, {
				agentId: parsed.agentId,
				agentName: target.agent_name,
				message,
				depth
			});
		}
		case 'await_agent': {
			const parsed = yield* decode(AwaitInput, input);
			yield* workbenchAgent(context, parsed.agentId);
			return yield* context.awaitTarget(context.effectId, parsed);
		}
		case 'steer_agent': {
			const parsed = yield* decode(MessageInput, input);
			const target = yield* workbenchAgent(context, parsed.agentId);
			const title = yield* ownTitle(context);
			const depth = yield* context.budget.nest(`steer from ${context.agentName}`);
			return yield* context.admit(context.effectId, {
				agentId: parsed.agentId,
				agentName: target.agent_name,
				message: {
					from: {
						agentId: context.conversationId,
						agentName: context.agentName,
						title
					},
					text: parsed.message
				},
				depth,
				mode: 'steer'
			});
		}
		case 'stop_agent':
		case 'resume_agent': {
			const parsed = yield* decode(AgentInput, input);
			yield* workbenchAgent(context, parsed.agentId, true);
			return yield* context[name === 'stop_agent' ? 'stop' : 'resume'](
				context.effectId,
				parsed
			);
		}
		default: {
			const _exhaustive: never = name;
			return _exhaustive;
		}
	}
});
