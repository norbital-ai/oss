import { Effect, Schema } from 'effect';
import { asc, eq, inArray } from 'drizzle-orm';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { ToolDeclaration } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import { ToolNotAllowed } from '#lib/runtime/agents/agent-errors.js';
import { encodeAgentMessage, type StoredAgentMessage } from '#lib/runtime/agents/agent-message.js';
import * as InvocationBudget from '#lib/runtime/budget.js';

const { chat_session: chatSession, chat_message: chatMessage } = SYSTEM_MODEL_TABLES;

const sandboxToolNames = [
	'spawn_agent',
	'list_agents',
	'read_agent',
	'message_agent',
	'await_agent',
	'interrupt_agent',
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
		description: "List this agent's direct parent and direct children.",
		command: 'platform:list_agents',
		inputSchema: objectInput({})
	},
	{
		name: 'read_agent',
		description: 'Read a direct child agent transcript.',
		command: 'platform:read_agent',
		inputSchema: agentIdInput
	},
	{
		name: 'message_agent',
		description: "Pass a message to this agent's direct parent or a direct child.",
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
		description: 'Run and wait for one exact task owned by a direct child agent.',
		command: 'platform:await_agent',
		inputSchema: objectInput(
			{
				agentId: { type: 'string', minLength: 1 },
				taskId: { type: 'string', minLength: 1 }
			},
			['agentId', 'taskId']
		)
	},
	...(['interrupt_agent', 'stop_agent', 'resume_agent'] as const).map((name): ToolDeclaration => ({
		name,
		description:
			name === 'interrupt_agent'
				? 'Interrupt only the currently running task of a direct child agent.'
				: name === 'stop_agent'
					? 'Stop a direct child agent at its next facility boundary.'
					: 'Replay one stopped task as a fresh invocation.',
		command: `platform:${name}`,
		inputSchema: agentIdInput
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
	readonly sandboxKey: string;
	readonly agentName: string;
	readonly conversationId: string;
	readonly database: Database.Interface;
	readonly budget: InvocationBudget.Interface;
	readonly spawn: SandboxAction;
	readonly admit: SandboxAction;
	/** Runs or joins one exact child task and returns only after its assistant row settles. */
	readonly awaitTarget: SandboxAction;
	readonly interrupt: SandboxAction;
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

const related = Effect.fn('Agents.related')(function* (
	context: SandboxContext,
	targetId: string,
	allowed: 'child' | 'message'
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
	const parent = current?.parent_id === targetId;
	if (
		current === undefined ||
		target === undefined ||
		current.sandbox_key !== context.sandboxKey ||
		target.sandbox_key !== context.sandboxKey ||
		(!child && (allowed === 'child' || !parent))
	) {
		return yield* new ToolNotAllowed({ agent: context.agentName, tool: 'agent-aperture' });
	}
	return { target, relation: child ? ('child' as const) : ('parent' as const) };
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

/** Coordinates one direct parent-child aperture; durable transcript rows are its only state. */
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
			const currentResult = yield* executeBuilt(
				context.effectId,
				context.database,
				composer
					.select({ parent_id: chatSession.parent_id })
					.from(chatSession)
					.where(eq(chatSession.conversation_id, context.conversationId))
					.limit(1)
			);
			const current = Schema.decodeUnknownOption(Schema.Struct({ parent_id: NullableString }))(
				currentResult.rows[0]
			);
			const parentId = current._tag === 'Some' ? current.value.parent_id : null;
			const parentResult =
				parentId === null
					? { rows: [] }
					: yield* executeBuilt(
							EffectId.make(`${context.effectId}:parent`),
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
								.where(eq(chatSession.conversation_id, parentId))
								.limit(1)
						);
			const childrenResult = yield* executeBuilt(
				EffectId.make(`${context.effectId}:children`),
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
					.where(eq(chatSession.parent_id, context.conversationId))
			);
			const adjacent = [...parentResult.rows, ...childrenResult.rows].flatMap((row) => {
				const decoded = decodeAgentRow(row);
				return decoded._tag === 'Some' && decoded.value.sandbox_key === context.sandboxKey
					? [decoded.value]
					: [];
			});
			const parent = adjacent.find(({ conversation_id }) => conversation_id === parentId);
			return {
				parent: parent === undefined ? null : agentView(parent),
				children: adjacent
					.filter(({ parent_id }) => parent_id === context.conversationId)
					.map(agentView)
			};
		}
		case 'read_agent': {
			const parsed = yield* decode(AgentInput, input);
			yield* related(context, parsed.agentId, 'child');
			const result = yield* executeBuilt(
				context.effectId,
				context.database,
				composer
					.select({ role: chatMessage.role, content: chatMessage.content })
					.from(chatMessage)
					.where(eq(chatMessage.conversation_id, parsed.agentId))
					.orderBy(asc(chatMessage.sequence))
			);
			return { agentId: parsed.agentId, messages: result.rows };
		}
		case 'message_agent': {
			const parsed = yield* decode(MessageInput, input);
			const target = yield* related(context, parsed.agentId, 'message');
			const title = yield* ownTitle(context);
			const depth = yield* context.budget.nest(`message from ${context.agentName}`);
			const message: StoredAgentMessage = encodeAgentMessage(
				{
					agentId: context.conversationId,
					agentName: context.agentName,
					title
				},
				parsed.message
			);
			return yield* context.admit(context.effectId, {
				agentId: parsed.agentId,
				agentName: target.target.agent_name,
				message,
				depth
			});
		}
		case 'await_agent': {
			const parsed = yield* decode(AwaitInput, input);
			yield* related(context, parsed.agentId, 'child');
			return yield* context.awaitTarget(context.effectId, parsed);
		}
		case 'interrupt_agent':
		case 'stop_agent':
		case 'resume_agent': {
			const parsed = yield* decode(AgentInput, input);
			yield* related(context, parsed.agentId, 'child');
			return yield* context[
				name === 'interrupt_agent' ? 'interrupt' : name === 'stop_agent' ? 'stop' : 'resume'
			](context.effectId, parsed);
		}
		default: {
			const _exhaustive: never = name;
			return _exhaustive;
		}
	}
});
