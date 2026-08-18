import { Effect, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { ToolDeclaration } from '../../authoring/workspace-schema.js';
import { Database } from '../facilities/database.js';
import { Tasks } from '../facilities/services.js';
import type { Identity } from '../identity/identity.js';
import { ToolNotAllowed } from './agent-errors.js';
import { encodeAgentMessage } from './agent-message.js';

export const sandboxToolNames = [
	'spawn_subagent',
	'list_sandbox_agents',
	'read_sandbox_agent',
	'message_sandbox_agent',
	'await_sandbox_agent'
] as const;
export type SandboxToolName = (typeof sandboxToolNames)[number];

export const isSandboxTool = (name: string): name is SandboxToolName =>
	(sandboxToolNames as ReadonlyArray<string>).includes(name);

export const sandboxToolSpecs: ReadonlyArray<ToolDeclaration> = [
	{
		name: 'spawn_subagent',
		description:
			'Spawn an in-session subagent for a task. Subagents cannot spawn further subagents.',
		command: 'platform:spawn_subagent'
	},
	{
		name: 'list_sandbox_agents',
		description:
			'List other agent sessions in this sandbox. A sandbox is the same person on web, or the same channel profile.',
		command: 'platform:list_sandbox_agents'
	},
	{
		name: 'read_sandbox_agent',
		description: 'Read a sibling session transcript in this sandbox.',
		command: 'platform:read_sandbox_agent'
	},
	{
		name: 'message_sandbox_agent',
		description: 'Send a message to a sibling session in this sandbox.',
		command: 'platform:message_sandbox_agent'
	},
	{
		name: 'await_sandbox_agent',
		description: 'Park this turn until a sibling session in this sandbox settles.',
		command: 'platform:await_sandbox_agent'
	}
];

export type SandboxContext = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	readonly agentName: string;
	readonly conversationId: string;
	readonly database: Database.Interface;
	readonly tasks: Tasks.Interface;
}>;

const TaskInput = Schema.Struct({ task: Schema.NonEmptyString });
const SessionInput = Schema.Struct({ sessionId: Schema.NonEmptyString });
const MessageInput = Schema.Struct({
	sessionId: Schema.NonEmptyString,
	message: Schema.NonEmptyString
});
const NullableString = Schema.Union([Schema.String, Schema.Null]);
const ConversationRow = Schema.Struct({
	id: Schema.String,
	agent_name: Schema.optionalKey(Schema.String),
	title: Schema.optionalKey(Schema.String)
});

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(() => new ToolNotAllowed({ agent: 'sandbox', tool: 'invalid-input' }))
	);

/**
 * The sibling session, once it is established that it belongs to this sandbox.
 *
 * Its name and title come back with the check rather than in a second read: every caller that is
 * allowed to touch a session is also the caller that has to say which session it touched, and a raw
 * conversation id says that to nobody.
 */
const sameSandbox = Effect.fn('Agents.sameSandbox')(function* (
	context: SandboxContext,
	sessionId: string
) {
	const result = yield* context.database.execute(context.effectId, {
		_tag: 'Query',
		sql: 'select id, user_id, agent_name, title from bolt_conversations where id = $1',
		parameters: [sessionId]
	});
	const row = result.rows[0];
	const decoded = Schema.decodeUnknownOption(
		Schema.Struct({
			id: Schema.String,
			user_id: Schema.String,
			agent_name: Schema.optionalKey(NullableString),
			title: Schema.optionalKey(NullableString)
		})
	)(row);
	if (decoded._tag === 'None' || decoded.value.user_id !== context.subject.userId) {
		return yield* new ToolNotAllowed({ agent: context.agentName, tool: 'sandbox-scope' });
	}
	return {
		id: decoded.value.id,
		agentName: decoded.value.agent_name ?? null,
		title: decoded.value.title ?? null
	};
});

/** This session's own title, which is how the reader on the other end tells two of its sessions apart. */
const ownTitle = Effect.fn('Agents.ownTitle')(function* (context: SandboxContext) {
	const result = yield* context.database.execute(EffectId.make(`${context.effectId}:sender`), {
		_tag: 'Query',
		sql: 'select title from bolt_conversations where id = $1',
		parameters: [context.conversationId]
	});
	const decoded = Schema.decodeUnknownOption(
		Schema.Struct({ title: Schema.optionalKey(NullableString) })
	)(result.rows[0]);
	return decoded._tag === 'Some' ? (decoded.value.title ?? null) : null;
});

/** Coordinates same-sandbox agent sessions and in-session subagent spawning. */
export const executeSandboxTool = Effect.fn('Agents.executeSandboxTool')(function* (
	name: SandboxToolName,
	input: Schema.Json,
	context: SandboxContext
) {
	switch (name) {
		case 'spawn_subagent': {
			if (context.conversationId.startsWith('subagent:')) {
				return yield* new ToolNotAllowed({ agent: context.agentName, tool: 'spawn_subagent' });
			}
			const parsed = yield* decode(TaskInput, input);
			const conversationId = `subagent:${context.effectId}`;
			// `parent_id` is what makes the delegated session findable from the one that spawned it:
			// the reader's transcript walks down it to nest this agent's work under the call, and the
			// usage roll-up walks up it so what this agent spends lands on the conversation the person
			// is actually looking at, however many levels of delegation lie between.
			yield* context.database.execute(EffectId.make(`${context.effectId}:spawn`), {
				_tag: 'Query',
				sql: 'insert into bolt_conversations (id, agent_name, user_id, title, parent_id) values ($1, $2, $3, $4, $5) on conflict do nothing',
				parameters: [
					conversationId,
					context.agentName,
					context.subject.userId,
					parsed.task,
					context.conversationId
				]
			});
			yield* context.tasks.execute(EffectId.make(`${context.effectId}:enqueue`), {
				_tag: 'Enqueue',
				command: 'agents.turn',
				input: {
					subject: context.subject,
					agent: context.agentName,
					conversationId,
					message: parsed.task
				}
			});
			return { waiting: true, conversationId };
		}
		case 'list_sandbox_agents': {
			const result = yield* context.database.execute(context.effectId, {
				_tag: 'Query',
				sql: 'select id, agent_name, title from bolt_conversations where user_id = $1',
				parameters: [context.subject.userId]
			});
			return {
				sessions: result.rows.flatMap((row) => {
					const decoded = Schema.decodeUnknownOption(ConversationRow)(row);
					return decoded._tag === 'Some' ? [decoded.value] : [];
				})
			};
		}
		case 'read_sandbox_agent': {
			const parsed = yield* decode(SessionInput, input);
			yield* sameSandbox(context, parsed.sessionId);
			const result = yield* context.database.execute(context.effectId, {
				_tag: 'Query',
				sql: 'select role, content from bolt_agent_messages where conversation_id = $1 order by sequence',
				parameters: [parsed.sessionId]
			});
			return { sessionId: parsed.sessionId, messages: result.rows };
		}
		case 'message_sandbox_agent': {
			const parsed = yield* decode(MessageInput, input);
			const target = yield* sameSandbox(context, parsed.sessionId);
			const title = yield* ownTitle(context);
			// `::jsonb` with an encoded value, like every other write to this log. The bare message text
			// went into a `jsonb` column unquoted, which is not JSON — the delivery failed in the database
			// rather than in the tool, so the sender was told it had landed.
			yield* context.database.execute(context.effectId, {
				_tag: 'Query',
				sql: 'insert into bolt_agent_messages (conversation_id, role, content) values ($1, $2, $3::jsonb)',
				parameters: [
					parsed.sessionId,
					'user',
					JSON.stringify(
						encodeAgentMessage(
							{ sessionId: context.conversationId, agentName: context.agentName, title },
							parsed.message
						)
					)
				]
			});
			// The recipient's name travels back so the sending transcript can say who it wrote to.
			return {
				sessionId: parsed.sessionId,
				delivered: true,
				agentName: target.agentName,
				title: target.title
			};
		}
		case 'await_sandbox_agent': {
			const parsed = yield* decode(SessionInput, input);
			const target = yield* sameSandbox(context, parsed.sessionId);
			yield* context.tasks.execute(EffectId.make(`${context.effectId}:await`), {
				_tag: 'Enqueue',
				command: 'agents.resume',
				input: {
					conversationId: context.conversationId,
					targetSessionId: parsed.sessionId
				}
			});
			return {
				waiting: true,
				targetSessionId: parsed.sessionId,
				agentName: target.agentName,
				title: target.title
			};
		}
		default: {
			const _exhaustive: never = name;
			return _exhaustive;
		}
	}
});
