import { Effect, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { ToolDeclaration } from '#lib/authoring/workspace-schema.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import { ToolNotAllowed } from '#lib/runtime/agents/agent-errors.js';
import { encodeAgentMessage } from '#lib/runtime/agents/agent-message.js';
import * as InvocationBudget from '#lib/runtime/budget.js';

const sandboxToolNames = [
	'spawn_subagent',
	'list_sandbox_agents',
	'read_sandbox_agent',
	'message_sandbox_agent',
	'await_sandbox_agent'
] as const;
const SandboxToolNames = Schema.Literals([...sandboxToolNames]);
type SandboxToolName = Schema.Schema.Type<typeof SandboxToolNames>;

export const isSandboxTool = Schema.is(SandboxToolNames);

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
			'List other agent sessions in this sandbox. A sandbox is one principal: the same person on web, one envoy, or one conversation with a public envoy.',
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

type SandboxContext = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	/**
	 * Which sandbox this turn is in — one tree per principal, and the only thing that scopes one.
	 *
	 * **Isolation is structural, not an authorization check.** No tool below accepts a principal id,
	 * so there is no call that could name somebody else's tree; every one of them takes a session id
	 * and is answered only if that session is in *this* key. An administrator cannot read a person's
	 * sandbox by being an administrator, for the same reason `bolt_personal_secrets` exists: bolting
	 * a `user_id` column onto a shared store would have kept the access rule and lost the isolation.
	 *
	 * For a person it is their `id`. For an envoy it is the envoy's own principal id — and
	 * on a **public** envoy it is that plus the conversation, because an envoy is one principal and
	 * without the partition every stranger who ever messaged it would share one tree, with a document
	 * one uploaded sitting where the next could read it.
	 */
	readonly sandboxKey: string;
	readonly agentName: string;
	readonly conversationId: string;
	readonly database: Database.Interface;
	readonly tasks: TaskQueue.Interface;
	/**
	 * How deep the chain that reached this turn already is, so a delegated turn can be refused before
	 * it is enqueued rather than after the tenth one has run.
	 *
	 * `spawn_subagent` already refuses to spawn from inside a subagent, which bounds delegation to one
	 * level *by that route*. This bounds the route that check cannot see: a subagent whose work fires
	 * an automation whose write fires a hook that starts another agent is a cycle in which no single
	 * step is delegation, and every step is satisfied by its own local rule.
	 */
	readonly budget: InvocationBudget.Interface;
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

/** The `ConversationRow` decoder, built once: it is evaluated for every listed session row. */
const decodeConversationRow = Schema.decodeUnknownOption(ConversationRow);

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
		sql: 'select conversation_id as id, user_id, agent_name, title from chat_session where conversation_id = $1',
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
	if (decoded._tag === 'None' || decoded.value.user_id !== context.sandboxKey) {
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
		sql: 'select title from chat_session where conversation_id = $1',
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
			const depth = yield* context.budget.nest(`subagent of ${context.agentName}`);
			const conversationId = `subagent:${context.effectId}`;
			// `parent_id` is what makes the delegated session findable from the one that spawned it:
			// the reader's transcript walks down it to nest this agent's work under the call, and the
			// usage roll-up walks up it so what this agent spends lands on the conversation the person
			// is actually looking at, however many levels of delegation lie between.
			yield* context.database.execute(EffectId.make(`${context.effectId}:spawn`), {
				_tag: 'Query',
				sql: 'insert into chat_session (conversation_id, agent_name, user_id, title, parent_id) values ($1, $2, $3, $4, $5) on conflict do nothing',
				parameters: [
					conversationId,
					context.agentName,
					context.sandboxKey,
					parsed.task,
					context.conversationId
				]
			});
			const spawnTaskId = `${context.effectId}:enqueue`;
			yield* context.tasks.enqueue(EffectId.make(spawnTaskId), [
				{
					command: 'agents.turn',
					input: InvocationBudget.stampDepth(
						{
							subject: context.subject,
							agent: context.agentName,
							conversationId,
							message: parsed.task
						},
						depth
					),
					effectId: spawnTaskId
				}
			]);
			return { spawned: true, conversationId };
		}
		case 'list_sandbox_agents': {
			const result = yield* context.database.execute(context.effectId, {
				_tag: 'Query',
				sql: 'select conversation_id as id, agent_name, title from chat_session where user_id = $1',
				parameters: [context.sandboxKey]
			});
			return {
				sessions: result.rows.flatMap((row) => {
					const decoded = decodeConversationRow(row);
					return decoded._tag === 'Some' ? [decoded.value] : [];
				})
			};
		}
		case 'read_sandbox_agent': {
			const parsed = yield* decode(SessionInput, input);
			yield* sameSandbox(context, parsed.sessionId);
			const result = yield* context.database.execute(context.effectId, {
				_tag: 'Query',
				sql: 'select role, content from chat_message where conversation_id = $1 order by sequence',
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
				sql: 'insert into chat_message (conversation_id, role, content) values ($1, $2, $3::jsonb)',
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
			// The target's settlement enqueues the continuation. Enqueueing here races the target and
			// makes a task retry stand in for the event the database already records durably.
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
