import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { AccessControl } from '../access/access-control.js';
import { ApprovalConflict } from '../approvals/approvals.js';
import { Collections, PendingApproval } from '../collections/collections.js';
import { AI, Connector, Files, HostTools, Tasks } from '../facilities/services.js';
import { Database } from '../facilities/database.js';
import type { Identity } from '../identity/identity.js';
import { RemoteRegistry } from '../remotes.js';
import type { WhereCompileError } from '../collections/where.js';
import { DispatchError, Workspace, WorkspaceLookupError } from '../workspace.js';
import type { AgentDeclaration, ToolDeclaration } from '../../authoring/workspace-schema.js';
import { SkillError, ToolNotAllowed } from './agent-errors.js';
import {
	executeHostTool,
	executePlatformTool,
	isPlatformTool,
	platformToolSpecs
} from './platform-tools.js';
import { agentMessageForModel, parseAgentMessage } from './agent-message.js';
import { executeSandboxTool, isSandboxTool, sandboxToolSpecs } from './sandbox-tools.js';

export { SkillError, ToolNotAllowed } from './agent-errors.js';

export const readSkill = Effect.fn('Agents.readSkill')(function* (effectId: EffectIdType, name: string) {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return yield* new SkillError({ name, reason: 'invalid-name' });
	const files = yield* Files.Service;
	const response = yield* files.execute(effectId, { _tag: 'Read', key: `skills/${name}/SKILL.md` });
	if (response.bytes === undefined) return yield* new SkillError({ name, reason: 'missing' });
	return new TextDecoder().decode(response.bytes);
});

/** Owns resolve tool behavior at the agents boundary so validation and typed semantics stay consistent for every caller. */
const AgentTools = {
	resolve: (agent: AgentDeclaration, name: string): ToolDeclaration | ToolNotAllowed =>
		agent.tools.find((tool) => tool.name === name) ?? new ToolNotAllowed({ agent: agent.name, tool: name }),
	mcpName: (server: string, tool: string): string => `${server.replaceAll(':', '_')}:${tool.replaceAll(':', '_')}`,
	parseMcpName: (name: string): { readonly server: string; readonly tool: string } | undefined => {
		const separator = name.indexOf(':');
		return separator < 1 || separator === name.length - 1 ? undefined : { server: name.slice(0, separator), tool: name.slice(separator + 1) };
	}
};
export const resolveTool = AgentTools.resolve;
export const mcpToolName = AgentTools.mcpName;
export const parseMcpToolName = AgentTools.parseMcpName;

const ToolCall = Schema.Struct({
	name: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Json)
});
const TurnOutput = Schema.Struct({
	text: Schema.optionalKey(Schema.String),
	toolCalls: Schema.optionalKey(Schema.Array(ToolCall))
});
const maxToolRounds = 8;

/**
 * One step of an agent turn. "Step" and "part" name the same thing: what the turn produced next.
 *
 * A turn is one message, so its steps are parts inside that message rather than messages of their
 * own. The log used to hold one `assistant` row per *round* and one `tool` row per answer, which
 * rendered a single turn as several separate agent blocks — the round is an artefact of how the tool
 * loop is driven, not something the reader asked about.
 */
const TurnPart = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('text'), text: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('tool'), id: Schema.NonEmptyString, name: Schema.NonEmptyString, input: Schema.Json }),
	Schema.Struct({ kind: Schema.Literal('tool-result'), id: Schema.NonEmptyString, name: Schema.NonEmptyString, output: Schema.Json })
]);
type TurnPart = Schema.Schema.Type<typeof TurnPart>;

/**
 * Expands one stored turn back into the alternating messages a provider accepts.
 *
 * The store keeps a turn whole because that is what the turn is; a provider instead wants the
 * assistant/tool alternation it emitted. Rebuilding it here is what lets the log hold the reader's
 * model without the prompt losing which answer belongs to which call.
 */
const replayTurn = (parts: ReadonlyArray<TurnPart>): ReadonlyArray<Schema.Json> => {
	const replayed: Array<Schema.Json> = [];
	let text: string | undefined;
	let calls: Array<Schema.Json> = [];
	const flush = () => {
		if (text === undefined && calls.length === 0) return;
		replayed.push({
			role: 'assistant',
			content: { ...(text === undefined ? {} : { text }), ...(calls.length === 0 ? {} : { toolCalls: calls }) }
		});
		text = undefined;
		calls = [];
	};
	for (const part of parts) {
		if (part.kind === 'text') {
			flush();
			text = part.text;
		} else if (part.kind === 'tool') {
			calls.push({ name: part.name, input: part.input });
		} else {
			flush();
			replayed.push({ role: 'tool', name: part.name, content: JSON.stringify(part.output) });
		}
	}
	flush();
	return replayed;
};

export const TurnResult = Schema.Struct({ conversationId: Schema.NonEmptyString, output: Schema.Json, status: Schema.Literals(['completed', 'waiting']) });
export interface TurnResult extends Schema.Schema.Type<typeof TurnResult> {}

const NullableString = Schema.Union([Schema.String, Schema.Null]);
const ConversationRow = Schema.Struct({
	id: Schema.String,
	agent_name: Schema.optionalKey(NullableString),
	title: Schema.optionalKey(NullableString)
});
const MessageRow = Schema.Struct({
	role: Schema.String,
	content: Schema.Json
});

export type Interface = Readonly<{
	readonly start: (effectId: EffectIdType, subject: Identity.Subject, agentName: string, conversationId: string) => Effect.Effect<void, Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError>;
	/** A turn can run a tool that queries a collection, so a refused filter is one of its failures. */
	readonly turn: (effectId: EffectIdType, subject: Identity.Subject, agentName: string, conversationId: string, message: string) => Effect.Effect<TurnResult, Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError | SkillError | ToolNotAllowed | ApprovalConflict | PendingApproval | WhereCompileError>;
	readonly resume: (effectId: EffectIdType, taskId: string, conversationId: string) => Effect.Effect<void, Database.FacilityError>;
	readonly cancel: (effectId: EffectIdType, taskId: string) => Effect.Effect<void, Database.FacilityError>;
	readonly updateVerifier: (effectId: EffectIdType, conversationId: string, verifier: Schema.Json) => Effect.Effect<void, Database.FacilityError>;
	readonly title: (effectId: EffectIdType, conversationId: string) => Effect.Effect<string, Database.FacilityError>;
	readonly listConversations: (effectId: EffectIdType, subject: Identity.Subject) => Effect.Effect<ReadonlyArray<Schema.Schema.Type<typeof ConversationRow>>, Database.FacilityError>;
	readonly history: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<
		Readonly<{ readonly conversationId: string; readonly title: string; readonly messages: ReadonlyArray<Schema.Schema.Type<typeof MessageRow>> }>,
		Database.FacilityError | AccessControl.AccessDenied
	>;
	readonly listSkills: (agentName: string) => Effect.Effect<ReadonlyArray<string>, Workspace.WorkspaceLookupError>;
	readonly readSkill: (effectId: EffectIdType, name: string) => ReturnType<typeof readSkill>;
}>;
/** Identifies the agents service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Agents');

export const layer = Layer.effect(Service, Effect.gen(function* () {
	const workspace = yield* Workspace.Service;
	const access = yield* AccessControl.Service;
	const ai = yield* AI.Service;
	const database = yield* Database.Service;
	const tasks = yield* Tasks.Service;
	const collections = yield* Collections.Service;
	const hostTools = yield* HostTools.Service;
	const files = yield* Files.Service;
	const connector = yield* Connector.Service;
	const remotes = yield* RemoteRegistry;

	const allowedTools = (agent: AgentDeclaration): ReadonlyArray<ToolDeclaration> => {
		const authored = new Map(agent.tools.map((tool) => [tool.name, tool]));
		return [
			...platformToolSpecs.filter((tool) => !authored.has(tool.name)),
			...sandboxToolSpecs.filter((tool) => !authored.has(tool.name)),
			...agent.tools
		];
	};

	const executeTool = Effect.fn('Agents.executeTool')(function* (
		agent: AgentDeclaration,
		name: string,
		input: Schema.Json,
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) {
		const allowlist = allowedTools(agent);
		const mcp = AgentTools.parseMcpName(name);
		if (
			!isPlatformTool(name) &&
			!isSandboxTool(name) &&
			mcp === undefined &&
			allowlist.every((tool) => tool.name !== name)
		) {
			return yield* new ToolNotAllowed({ agent: agent.name, tool: name });
		}
		const context = {
			effectId,
			subject,
			agentName: agent.name,
			skills: agent.skills,
			workspace,
			collections,
			hostTools,
			files
		};
		if (isPlatformTool(name)) return yield* executePlatformTool(name, input, context);
		if (isSandboxTool(name)) {
			return yield* executeSandboxTool(name, input, {
				effectId,
				subject,
				agentName: agent.name,
				conversationId,
				database,
				tasks
			});
		}
		if (mcp !== undefined) {
			return (yield* connector.execute(effectId, {
				connector: mcp.server,
				operation: mcp.tool,
				input
			})).output;
		}
		type AuthoredLookup =
			| { readonly _tag: 'hit'; readonly value: Schema.Json }
			| { readonly _tag: 'miss' };
		const authored = yield* remotes.invoke(name, input, subject, effectId).pipe(
			Effect.map((value): AuthoredLookup => ({ _tag: 'hit', value })),
			Effect.catch((error): Effect.Effect<AuthoredLookup> =>
				error instanceof DispatchError && error.code === 'unknown_remote'
					? Effect.succeed({ _tag: 'miss' })
					: Effect.succeed({
							_tag: 'hit',
							value: { error: error instanceof Error ? error.message : String(error) }
						})
			)
		);
		if (authored._tag === 'hit') return authored.value;
		const declared = allowlist.find((tool) => tool.name === name);
		if (name.startsWith('sandbox_') || declared?.command.startsWith('host:') === true) {
			return yield* executeHostTool(name, input, context);
		}
		return yield* new ToolNotAllowed({ agent: agent.name, tool: name });
	});

	return Service.of({
		start: Effect.fn('Agents.start')(function* (effectId, subject, agentName, conversationId) {
			yield* workspace.agent(agentName).pipe(
				Effect.catch((error) =>
					error instanceof WorkspaceLookupError
						? Effect.fail(new AccessControl.AccessDenied({ action: 'agent', resource: agentName, reason: 'unknown agent' }))
						: Effect.fail(error)
				)
			);
			yield* access.authorize(subject, 'agent', agentName);
			yield* database.execute(effectId, { _tag: 'Query', sql: 'insert into bolt_conversations (id, agent_name, user_id) values ($1, $2, $3) on conflict do nothing', parameters: [conversationId, agentName, subject.userId] });
		}),
		// stupidity:allow Q3 -- the tool loop and the records it writes are one unit of meaning
		turn: Effect.fn('Agents.turn')(function* (effectId, subject, agentName, conversationId, message) {
			const agent = yield* workspace.agent(agentName).pipe(
				Effect.catch((error) =>
					error instanceof WorkspaceLookupError
						? Effect.fail(new AccessControl.AccessDenied({ action: 'agent', resource: agentName, reason: 'unknown agent' }))
						: Effect.fail(error)
				)
			);
			yield* access.authorize(subject, 'agent', agentName);
			yield* database.execute(EffectId.make(`${effectId}:ensure-conversation`), {
				_tag: 'Query',
				sql: 'insert into bolt_conversations (id, agent_name, user_id) values ($1, $2, $3) on conflict do nothing',
				parameters: [conversationId, agentName, subject.userId]
			});
			const transcript = yield* database.execute(EffectId.make(`${effectId}:read`), {
				_tag: 'Query', sql: 'select role, content from bolt_agent_messages where conversation_id = $1 order by sequence', parameters: [conversationId]
			});
			const tools = allowedTools(agent).map(({ name, description, command }) => ({
				name,
				description,
				command
			}));
			const messages: Array<Schema.Json> = [
				{ role: 'system', content: agent.prompt },
				...transcript.rows.flatMap((row): ReadonlyArray<Schema.Json> => {
					const decoded = Schema.decodeUnknownOption(MessageRow)(row);
					if (decoded._tag === 'None') return [];
					// A sibling agent's message is stored with its sender so the prompt can attribute it. Handed
					// on as the stored record it would reach the provider as an object where a string belongs,
					// and unattributed it would read as something the person asked for.
					const relayed = parseAgentMessage(decoded.value.content);
					if (relayed !== null) return [{ role: 'user', content: agentMessageForModel(relayed) }];
					const whole = Schema.decodeUnknownOption(Schema.Struct({ parts: Schema.Array(TurnPart) }))(decoded.value.content);
					// An assistant row is a whole turn; anything else is already one provider message.
					return whole._tag === 'Some' ? replayTurn(whole.value.parts) : [decoded.value];
				}),
				{ role: 'user', content: message }
			];
			let written = 0;
			/** Appends one record to the conversation log; `::jsonb` parses the encoded value back out. */
			const persist = (role: string, content: Schema.Json) =>
				database.execute(EffectId.make(`${effectId}:persist:${(written += 1)}`), {
					_tag: 'Query',
					sql: 'insert into bolt_agent_messages (conversation_id, role, content) values ($1, $2, $3::jsonb)',
					parameters: [conversationId, role, JSON.stringify(content)]
				});
			/**
			 * The turn's own message, rewritten as each step lands.
			 *
			 * One agent turn is one assistant message, so the turn's lifecycle is a field of that message
			 * rather than a record beside it: there is no second row to keep in step with the parts it owns,
			 * and `content->>'id'` addresses it because only a turn carries one. The rewrite happens per step
			 * rather than once at the end because a step the reader cannot see until the turn is over is a
			 * step they watched the composer sit locked through.
			 */
			const parts: Array<TurnPart> = [];
			let committed = 0;
			const commit = (status: 'running' | 'completed' | 'failed') =>
				database.execute(EffectId.make(`${effectId}:turn:${(committed += 1)}`), {
					_tag: 'Query',
					sql: "update bolt_agent_messages set content = $3::jsonb where conversation_id = $1 and content->>'id' = $2",
					parameters: [conversationId, effectId, JSON.stringify({ id: effectId, status, subagent_id: null, parts })]
				});
			// Written before the model runs, not after it answers: a turn that fails mid-flight is exactly
			// the one the reader needs to see, and a prompt persisted only on success loses it.
			yield* persist('user', message);
			yield* persist('assistant', { id: effectId, status: 'running', subagent_id: null, parts: [] });
			const settled = yield* Effect.gen(function* () {
				let output: Schema.Json = null;
				let status: TurnResult['status'] = 'completed';
				for (let round = 0; round < maxToolRounds; round += 1) {
					const response = yield* ai.execute(EffectId.make(`${effectId}:ai:${round}`), {
						_tag: 'Turn',
						model: 'default',
						messages,
						tools,
						maxOutputTokens: 2048
					});
					output = response.output;
					const decoded = Schema.decodeUnknownOption(TurnOutput)(response.output);
					const toolCalls =
						decoded._tag === 'Some' ? (decoded.value.toolCalls ?? []) : [];
					const text = decoded._tag === 'Some' ? decoded.value.text : undefined;
					if (toolCalls.length === 0) {
						status = 'completed';
						parts.push({ kind: 'text', text: text ?? '' });
						yield* commit('running');
						break;
					}
					status = 'waiting';
					// The provider names no call ids, so the loop assigns them. A stored answer has to name
					// the call it answers or the two cannot be paired, and two calls to one tool in a round
					// would otherwise collide on both that name and the effect id derived from it.
					const calls = toolCalls.map((call, index) => ({
						id: `${effectId}:tool:${round}:${index}`,
						name: call.name,
						input: call.input ?? null
					}));
					// A round contributes parts to the turn it belongs to. It used to open a message of its own,
					// which is why one turn rendered as several separate agent blocks.
					if (text !== undefined && text.trim().length > 0) parts.push({ kind: 'text', text });
					for (const call of calls) parts.push({ kind: 'tool', id: call.id, name: call.name, input: call.input });
					// Committed before the calls run, so a call the reader can see is one that has been made.
					yield* commit('running');
					messages.push({ role: 'assistant', content: response.output });
					let parked = false;
					for (const call of calls) {
						const result = yield* executeTool(
							agent,
							call.name,
							call.input,
							EffectId.make(call.id),
							subject,
							conversationId
						);
						const encoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
							JSON.stringify(result)
						).pipe(Effect.catch(() => Effect.succeed({ error: 'invalid-tool-result' })));
						// The answer lands the moment the call returns, so a call still without one reads as
						// running rather than as a call that was never made.
						parts.push({ kind: 'tool-result', id: call.id, name: call.name, output: encoded });
						yield* commit('running');
						messages.push({
							role: 'tool',
							name: call.name,
							content: JSON.stringify(encoded)
						});
						const waiting = Schema.decodeUnknownOption(
							Schema.Struct({ waiting: Schema.Literal(true) })
						)(encoded);
						if (waiting._tag === 'Some') {
							output = encoded;
							parked = true;
							break;
						}
					}
					if (parked) break;
				}
				return { output, status };
			}).pipe(
				// Ignored rather than propagated: a lifecycle write that fails must not replace the failure
				// the caller is waiting to be told about.
				Effect.onError(() => Effect.ignore(commit('failed')))
			);
			// A parked turn is still running — it resumes when the subagent answers — so only a turn that
			// reached an answer settles here.
			if (settled.status === 'completed') yield* commit('completed');
			yield* tasks.execute(EffectId.make(`${effectId}:continue`), { _tag: 'Enqueue', command: 'agents.resume', input: { conversationId } });
			return { conversationId, output: settled.output, status: settled.status };
		}),
		resume: Effect.fn('Agents.resume')(function* (effectId, taskId, conversationId) {
			yield* tasks.execute(effectId, { _tag: 'Signal', taskId, signal: 'resume', input: { conversationId } });
		}),
		cancel: Effect.fn('Agents.cancel')(function* (effectId, taskId) { yield* tasks.execute(effectId, { _tag: 'Cancel', taskId }); }),
		updateVerifier: Effect.fn('Agents.updateVerifier')(function* (effectId, conversationId, verifier) {
			yield* database.execute(effectId, { _tag: 'Query', sql: 'update bolt_conversations set verifier = $2 where id = $1', parameters: [conversationId, verifier] });
		}),
		title: Effect.fn('Agents.title')(function* (effectId, conversationId) {
			const result = yield* database.execute(effectId, { _tag: 'Query', sql: 'select title from bolt_conversations where id = $1', parameters: [conversationId] });
			const row = result.rows[0];
			const decoded = Schema.decodeUnknownOption(Schema.Struct({ title: Schema.optionalKey(Schema.String) }))(row);
			if (decoded._tag === 'Some' && decoded.value.title) return decoded.value.title;
			return 'New conversation';
		}),
		listConversations: Effect.fn('Agents.listConversations')(function* (effectId, subject) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'select id, agent_name, title from bolt_conversations where user_id = $1 order by id desc',
				parameters: [subject.userId]
			});
			return result.rows.flatMap((row) => {
				const decoded = Schema.decodeUnknownOption(ConversationRow)(row);
				return decoded._tag === 'Some' ? [decoded.value] : [];
			});
		}),
		history: Effect.fn('Agents.history')(function* (effectId, subject, conversationId) {
			const owned = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'select id, title from bolt_conversations where id = $1 and user_id = $2',
				parameters: [conversationId, subject.userId]
			});
			const conversation = Schema.decodeUnknownOption(
				Schema.Struct({ id: Schema.String, title: Schema.optionalKey(NullableString) })
			)(owned.rows[0]);
			if (conversation._tag === 'None') {
				return yield* new AccessControl.AccessDenied({
					action: 'read',
					resource: conversationId,
					reason: 'unknown conversation'
				});
			}
			const transcript = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'select role, content from bolt_agent_messages where conversation_id = $1 order by sequence',
				parameters: [conversationId]
			});
			return {
				conversationId,
				title: conversation.value.title ?? 'New conversation',
				messages: transcript.rows.flatMap((row) => {
					const decoded = Schema.decodeUnknownOption(MessageRow)(row);
					return decoded._tag === 'Some' ? [decoded.value] : [];
				})
			};
		}),
		listSkills: Effect.fn('Agents.listSkills')(function* (agentName) { return (yield* workspace.agent(agentName)).skills; }),
		readSkill
	});
}));

export * as Agents from './agents.js';
