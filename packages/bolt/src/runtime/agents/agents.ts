import { Context, Effect, Layer, Schema } from 'effect';
import {
	addAIUsage,
	EffectId,
	readAIUsage,
	type AIUsage,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import { AccessControl } from '../access/access-control.js';
import { ApprovalConflict } from '../approvals/approvals.js';
import { Collections, PendingApproval } from '../collections/collections.js';
import { AI, Connector, Files, HostTools } from '../facilities/services.js';
import { TaskQueue } from '../tasks/tasks.js';
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
import { InvocationBudget } from '../budget.js';
import { AuthoredRefusal } from '../../authoring/refusal.js';

export { SkillError, ToolNotAllowed } from './agent-errors.js';

export const readSkill = Effect.fn('Agents.readSkill')(function* (
	effectId: EffectIdType,
	name: string
) {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
		return yield* new SkillError({ name, reason: 'invalid-name' });
	const files = yield* Files.Service;
	const response = yield* files.execute(effectId, { _tag: 'Read', key: `skills/${name}/SKILL.md` });
	if (response.bytes === undefined) return yield* new SkillError({ name, reason: 'missing' });
	return new TextDecoder().decode(response.bytes);
});

/** Owns resolve tool behavior at the agents boundary so validation and typed semantics stay consistent for every caller. */
const AgentTools = {
	resolve: (agent: AgentDeclaration, name: string): ToolDeclaration | ToolNotAllowed =>
		agent.tools.find((tool) => tool.name === name) ??
		new ToolNotAllowed({ agent: agent.name, tool: name }),
	mcpName: (server: string, tool: string): string =>
		`${server.replaceAll(':', '_')}:${tool.replaceAll(':', '_')}`,
	parseMcpName: (name: string): { readonly server: string; readonly tool: string } | undefined => {
		const separator = name.indexOf(':');
		return separator < 1 || separator === name.length - 1
			? undefined
			: { server: name.slice(0, separator), tool: name.slice(separator + 1) };
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
	Schema.Struct({
		kind: Schema.Literal('tool'),
		id: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		input: Schema.Json
	}),
	Schema.Struct({
		kind: Schema.Literal('tool-result'),
		id: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		output: Schema.Json
	})
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
			content: {
				...(text === undefined ? {} : { text }),
				...(calls.length === 0 ? {} : { toolCalls: calls })
			}
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

export const TurnResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	output: Schema.Json,
	status: Schema.Literals(['completed', 'waiting'])
});
export interface TurnResult extends Schema.Schema.Type<typeof TurnResult> {}

/**
 * What one conversation has cost, counting everything it delegated.
 *
 * Cumulative counters read off the session row rather than a sum taken over the transcript: the
 * figures have to outlive the messages that produced them, and a conversation whose history was
 * compacted is not a conversation that stopped spending money.
 *
 * `turnsUnreported` is what stops a total reading as exact when it is a floor. A host that reports
 * no cost for a turn has not told us the turn was free.
 */
export const ConversationUsage = Schema.Struct({
	/** The provider's own charge, kept as the audit figure behind the one below. */
	costUsd: Schema.Number,
	/**
	 * What the host will invoice for this conversation, in millionths of `costCurrency`.
	 *
	 * This is the figure a reader takes for the price, so it is the host's own — a provider charge in
	 * one currency shown to someone invoiced in another understates it silently. Zero with no
	 * currency means the host priced nothing and only the provider figure exists.
	 */
	costMicroUnits: Schema.Number,
	costCurrency: Schema.Union([Schema.String, Schema.Null]),
	totalTokens: Schema.Number,
	turnsCounted: Schema.Number,
	turnsUnreported: Schema.Number
});
export interface ConversationUsage extends Schema.Schema.Type<typeof ConversationUsage> {}

/**
 * How deep the spend roll-up and the transcript walk follow delegation.
 *
 * The loop already refuses a subagent that spawns another, so the real tree is one level. The bound
 * exists so a cycle written into `parent_id` fails as a truncated walk rather than as a recursive
 * query that never returns — and so raising the delegation limit later changes one number here
 * instead of finding this code by way of a hung request.
 */
const maxDelegationDepth = 8;

const NullableString = Schema.Union([Schema.String, Schema.Null]);
const ConversationRow = Schema.Struct({
	id: Schema.String,
	agent_name: Schema.optionalKey(NullableString),
	title: Schema.optionalKey(NullableString)
});
const MessageRow = Schema.Struct({
	role: Schema.String,
	content: Schema.Json,
	/**
	 * The turn this row belongs to, or nothing for a row no turn produced.
	 *
	 * A delegated session's rows come back inside its parent's history, so the reader's projection
	 * needs to know which call's transcript each row belongs to. Ordering cannot answer that: a
	 * subagent writes while its parent is parked, so its rows sit in the middle of the parent's
	 * sequence and read as messages the person sent.
	 */
	turn_id: Schema.optionalKey(NullableString)
});

/** One conversation's stored usage counters, as the session row carries them. */
const UsageRow = Schema.Struct({
	usage_cost_usd: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
	usage_cost_micro_units: Schema.optionalKey(
		Schema.Union([Schema.Number, Schema.String, Schema.Null])
	),
	usage_cost_currency: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	usage_total_tokens: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
	usage_turns_counted: Schema.optionalKey(
		Schema.Union([Schema.Number, Schema.String, Schema.Null])
	),
	usage_turns_unreported: Schema.optionalKey(
		Schema.Union([Schema.Number, Schema.String, Schema.Null])
	)
});

/**
 * Reads one counter off a session row.
 *
 * `bigint` and `double precision` come back from some drivers as strings, and a counter silently
 * read as `NaN` would render a conversation as having spent nothing rather than as having spent
 * something this code could not read.
 */
const usageNumber = (value: unknown): number => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
};

/** The session's cumulative usage, or zeroes for a conversation that has settled no turn yet. */
const conversationUsage = (row: unknown): ConversationUsage => {
	const decoded = Schema.decodeUnknownOption(UsageRow)(row);
	const source = decoded._tag === 'Some' ? decoded.value : {};
	return {
		costUsd: usageNumber(source.usage_cost_usd),
		costMicroUnits: usageNumber(source.usage_cost_micro_units),
		costCurrency:
			typeof source.usage_cost_currency === 'string' ? source.usage_cost_currency : null,
		totalTokens: usageNumber(source.usage_total_tokens),
		turnsCounted: usageNumber(source.usage_turns_counted),
		turnsUnreported: usageNumber(source.usage_turns_unreported)
	};
};

export type Interface = Readonly<{
	readonly start: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		agentName: string,
		conversationId: string
	) => Effect.Effect<
		void,
		Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError
	>;
	/** A turn can run a tool that queries a collection, so a refused filter is one of its failures. */
	readonly turn: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		agentName: string,
		conversationId: string,
		message: string,
		/**
		 * Who is speaking, when the caller knows something the transcript does not.
		 *
		 * A channel message arrives from a phone number, and the person behind it may or may not have
		 * an account — so the agent has to be *told* who it is answering, and told separately from
		 * what they said. It is a system message rather than a prefix on `message` precisely so the
		 * model cannot confuse a fact the runtime asserted with a claim the sender typed; somebody
		 * writing "I am the site controller" into WhatsApp must not read as this.
		 *
		 * It grants nothing and is not consulted by anything. Capability is `subject`'s, resolved
		 * from a team through `+teams.ts`, whatever this string says.
		 */
		senderContext?: string
	) => Effect.Effect<
		TurnResult,
		| Workspace.WorkspaceLookupError
		| AccessControl.AccessDenied
		| Database.FacilityError
		| SkillError
		| ToolNotAllowed
		| ApprovalConflict
		| PendingApproval
		| WhereCompileError
		// A turn runs authored code — its tools reach collections and remotes — so a business rule
		// can refuse it, and a delegated turn can be stopped by the nesting bound. Both were
		// reaching this boundary already; only the declaration did not say so, which is how a
		// refusal here left as something a caller could not name.
		| AuthoredRefusal
		| InvocationBudget.NestingLimitExceeded
	>;
	readonly resume: (
		effectId: EffectIdType,
		taskId: string,
		conversationId: string
	) => Effect.Effect<void, Database.FacilityError>;
	readonly cancel: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<void, Database.FacilityError>;
	readonly updateVerifier: (
		effectId: EffectIdType,
		conversationId: string,
		verifier: Schema.Json
	) => Effect.Effect<void, Database.FacilityError>;
	readonly title: (
		effectId: EffectIdType,
		conversationId: string
	) => Effect.Effect<string, Database.FacilityError>;
	readonly listConversations: (
		effectId: EffectIdType,
		subject: Identity.Subject
	) => Effect.Effect<
		ReadonlyArray<Schema.Schema.Type<typeof ConversationRow>>,
		Database.FacilityError
	>;
	/**
	 * One conversation as the reader sees it: its own rows, everything it delegated, and what it cost.
	 *
	 * Delegated rows come back here rather than through a second command because they are not a second
	 * conversation — nobody started them and nobody can reply to them. They are what one call in this
	 * transcript did, and the panel nests them under that call.
	 */
	readonly history: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<
		Readonly<{
			readonly conversationId: string;
			readonly title: string;
			readonly messages: ReadonlyArray<Schema.Schema.Type<typeof MessageRow>>;
			readonly usage: ConversationUsage;
		}>,
		Database.FacilityError | AccessControl.AccessDenied
	>;
	readonly listSkills: (
		agentName: string
	) => Effect.Effect<ReadonlyArray<string>, Workspace.WorkspaceLookupError>;
	readonly readSkill: (effectId: EffectIdType, name: string) => ReturnType<typeof readSkill>;
}>;
/** Identifies the agents service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Agents');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const access = yield* AccessControl.Service;
		const ai = yield* AI.Service;
		const database = yield* Database.Service;
		const queue = yield* TaskQueue.Service;
		const collections = yield* Collections.Service;
		const hostTools = yield* HostTools.Service;
		const files = yield* Files.Service;
		const connector = yield* Connector.Service;
		const budget = yield* InvocationBudget.Service;
		const remotes = yield* RemoteRegistry;

		/**
		 * The tools one turn is offered, after `src/+agent.ts` has had its say.
		 *
		 * Every clause here was declared on `AgentAutomationSpec` and enforced by nothing: the funnel
		 * returned the platform set, the sandbox set and the workspace's tools unconditionally, so a
		 * workspace that declared `access: 'read'` shipped an agent holding `write_collection` and one
		 * that named `denyTools` shipped an agent holding all of them.
		 *
		 * `denyTools` cannot withhold a bound sandbox, which is what the authoring skill says of it: the
		 * sandbox set is the host's, and an agent that could hide its own siblings could hide what it did
		 * with them. `hostTools` is the opposite direction — nothing non-sandbox is offered unless the
		 * workspace opted into it by name.
		 */
		const allowedTools = (agent: AgentDeclaration): ReadonlyArray<ToolDeclaration> => {
			const authored = new Map(agent.tools.map((tool) => [tool.name, tool]));
			const denied = new Set(agent.denyTools ?? []);
			const platform = platformToolSpecs
				.filter((tool) => !authored.has(tool.name) && !denied.has(tool.name))
				.filter((tool) => tool.name !== 'write_collection' || agent.access === 'write');
			const host = (agent.hostTools ?? [])
				.filter((name) => !authored.has(name) && !denied.has(name) && !isSandboxTool(name))
				.map((name) => ({ name, description: `Host tool ${name}`, command: `host:${name}` }));
			return [
				...platform,
				...sandboxToolSpecs.filter((tool) => !authored.has(tool.name)),
				...host,
				...agent.tools.filter((tool) => !denied.has(tool.name))
			];
		};

		/**
		 * Whether an MCP tool name reaches a server this agent may call.
		 *
		 * Declaring `mcpServers` narrows the agent to those; declaring none leaves the connector facility
		 * as the only gate, which is what it has always been — a name it has no connector for fails there.
		 * Absent does not mean "none", because a workspace that declares `src/mcp/+<name>.mcp.ts` and no
		 * `+agent.ts` would otherwise lose every server it authored to a field it never wrote.
		 */
		const mcpAllowed = (agent: AgentDeclaration, server: string): boolean =>
			agent.mcpServers === undefined || agent.mcpServers.includes(server);

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
			const offered = allowlist.some((tool) => tool.name === name);
			// A platform or sandbox name was admitted on the strength of being one, which made `denyTools`
			// and `access` advisory: an agent that was never offered `write_collection` could still call
			// it by name. The allowlist is the answer for every kind now, and an MCP call is admitted only
			// when the workspace named that server.
			if (
				!offered &&
				!isSandboxTool(name) &&
				!(mcp !== undefined && mcpAllowed(agent, mcp.server))
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
				files,
				...(agent.collections === undefined ? {} : { allowedCollections: agent.collections })
			};
			if (isPlatformTool(name)) return yield* executePlatformTool(name, input, context);
			if (isSandboxTool(name)) {
				return yield* executeSandboxTool(name, input, {
					effectId,
					subject,
					agentName: agent.name,
					conversationId,
					database,
					tasks: queue,
					budget
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
				{ readonly _tag: 'hit'; readonly value: Schema.Json } | { readonly _tag: 'miss' };
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
			// A `hostTools` opt-in lands here: the funnel gives each named tool a `host:` command, and this
			// is the branch that routes one. The opt-in reached nothing before, because nothing put a
			// `host:` tool in the allowlist for it to find.
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
							? Effect.fail(
									new AccessControl.AccessDenied({
										action: 'agent',
										resource: agentName,
										reason: 'unknown agent'
									})
								)
							: Effect.fail(error)
					)
				);
				yield* access.authorize(subject, 'agent', agentName);
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_conversations (id, agent_name, user_id) values ($1, $2, $3) on conflict do nothing',
					parameters: [conversationId, agentName, subject.userId]
				});
			}),
			// stupidity:allow Q3 -- the tool loop and the records it writes are one unit of meaning
			turn: Effect.fn('Agents.turn')(
				function* (effectId, subject, agentName, conversationId, message, senderContext) {
					const agent = yield* workspace.agent(agentName).pipe(
						Effect.catch((error) =>
							error instanceof WorkspaceLookupError
								? Effect.fail(
										new AccessControl.AccessDenied({
											action: 'agent',
											resource: agentName,
											reason: 'unknown agent'
										})
									)
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
						_tag: 'Query',
						sql: 'select role, content from bolt_agent_messages where conversation_id = $1 order by sequence',
						parameters: [conversationId]
					});
					const tools = allowedTools(agent).map(({ name, description, command }) => ({
						name,
						description:
							(name === 'read_collection' || name === 'write_collection') &&
							agent.collections !== undefined
								? // The ceiling declared in `src/+agent.ts`, stated where the model can see it
									// before it guesses. Without this the model is offered `read_collection` with
									// no way to know the agent is scoped, and the first call to a collection
									// outside the scope is a refusal it could have avoided.
									`${description} Allowed collections: ${agent.collections.join(', ')}.`
								: description,
						command
					}));
					const messages: Array<Schema.Json> = [
						{ role: 'system', content: agent.prompt },
						// Second and separate, so the agent's standing instruction stays the thing the author
						// wrote and this stays the runtime's own statement about who it is talking to.
						...(senderContext === undefined
							? []
							: [{ role: 'system', content: senderContext } as Schema.Json]),
						...transcript.rows.flatMap((row): ReadonlyArray<Schema.Json> => {
							const decoded = Schema.decodeUnknownOption(MessageRow)(row);
							if (decoded._tag === 'None') return [];
							// A sibling agent's message is stored with its sender so the prompt can attribute it. Handed
							// on as the stored record it would reach the provider as an object where a string belongs,
							// and unattributed it would read as something the person asked for.
							const relayed = parseAgentMessage(decoded.value.content);
							if (relayed !== null)
								return [{ role: 'user', content: agentMessageForModel(relayed) }];
							const whole = Schema.decodeUnknownOption(
								Schema.Struct({ parts: Schema.Array(TurnPart) })
							)(decoded.value.content);
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
							sql: 'insert into bolt_agent_messages (conversation_id, role, content, turn_id) values ($1, $2, $3::jsonb, $4)',
							parameters: [conversationId, role, JSON.stringify(content), effectId]
						});
					/**
					 * The call this session was delegated by, or nothing when a person started it.
					 *
					 * `spawn_subagent` names the child session after the call that spawned it, so the id is
					 * already the join the reader's panel makes between a call and the transcript beneath it.
					 * It used to be written as `null` unconditionally, which is why a delegated transcript never
					 * appeared under the call that caused it.
					 */
					const delegatedBy = conversationId.startsWith('subagent:') ? conversationId : null;
					/**
					 * What this turn's model calls cost, folded across its rounds.
					 *
					 * A turn is one message however many times the loop had to go back to the model, so its
					 * spend is one figure too — a per-round breakdown would report eight charges for something
					 * the reader asked once.
					 */
					let turnUsage: AIUsage | undefined;
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
							parameters: [
								conversationId,
								effectId,
								JSON.stringify({
									id: effectId,
									status,
									subagent_id: delegatedBy,
									parts,
									...(turnUsage === undefined ? {} : { usage: turnUsage })
								})
							]
						});
					// Written before the model runs, not after it answers: a turn that fails mid-flight is exactly
					// the one the reader needs to see, and a prompt persisted only on success loses it.
					yield* persist('user', message);
					yield* persist('assistant', {
						id: effectId,
						status: 'running',
						subagent_id: delegatedBy,
						parts: []
					});
					/**
					 * Adds this turn to the running totals of its session and of every session above it.
					 *
					 * The walk is up the `parent_id` chain rather than one hop, because the figure the reader is
					 * shown belongs to the conversation they are looking at — and what a delegated agent spent
					 * was spent on their behalf, however many levels down it happened. Counting only the session
					 * that made the call would report a conversation which delegated all its work as free.
					 *
					 * The counters are incremented in the database rather than read, added and written back: two
					 * delegated sessions settling at once would otherwise each write a total computed before the
					 * other's, and one of the two turns would vanish from the bill.
					 */
					const recordTurnUsage = Effect.fn('Agents.recordTurnUsage')(function* () {
						const reported = turnUsage?.costUsd !== undefined;
						yield* database.execute(EffectId.make(`${effectId}:usage`), {
							_tag: 'Query',
							sql: `with recursive lineage as (
							select id, parent_id, 0 as depth from bolt_conversations where id = $1
							union all
							select above.id, above.parent_id, lineage.depth + 1 from bolt_conversations above
								join lineage on above.id = lineage.parent_id
								where lineage.depth < ${maxDelegationDepth}
						)
						update bolt_conversations set
							usage_cost_usd = usage_cost_usd + $2,
							usage_cost_micro_units = usage_cost_micro_units + $3,
							usage_cost_currency = coalesce($4::text, usage_cost_currency),
							usage_total_tokens = usage_total_tokens + $5,
							usage_turns_counted = usage_turns_counted + 1,
							usage_turns_unreported = usage_turns_unreported + $6
						where id in (select id from lineage)`,
							parameters: [
								conversationId,
								turnUsage?.costUsd ?? 0,
								Math.round(turnUsage?.costMicroUnits ?? 0),
								// `coalesce` rather than an overwrite: a turn the host did not price must not blank
								// the currency the conversation's running total is already denominated in.
								turnUsage?.costCurrency ?? null,
								Math.round(turnUsage?.totalTokens ?? 0),
								reported ? 0 : 1
							]
						});
					});
					const settled = yield* Effect.gen(function* () {
						let output: Schema.Json = null;
						let status: TurnResult['status'] = 'completed';
						for (let round = 0; round < maxToolRounds; round += 1) {
							const response = yield* ai.execute(EffectId.make(`${effectId}:ai:${round}`), {
								_tag: 'Turn',
								// Both were literals, so `src/+agent.ts` naming a model and a budget changed nothing:
								// a workspace that raised `maxTokens` because a reasoning model spends real tokens
								// between tool calls still got 2048 and still ran out on the third call.
								model: agent.model ?? 'default',
								messages,
								tools,
								maxOutputTokens: agent.maxTokens ?? 2048
							});
							output = response.output;
							// Folded in before anything can fail below: a round that answered and then threw is a
							// round the provider charged for, and dropping its usage would bill the tenant for a
							// turn the ledger says was free.
							turnUsage = addAIUsage(turnUsage, readAIUsage(response.usage));
							const decoded = Schema.decodeUnknownOption(TurnOutput)(response.output);
							const toolCalls = decoded._tag === 'Some' ? (decoded.value.toolCalls ?? []) : [];
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
							for (const call of calls)
								parts.push({ kind: 'tool', id: call.id, name: call.name, input: call.input });
							// Committed before the calls run, so a call the reader can see is one that has been made.
							yield* commit('running');
							messages.push({ role: 'assistant', content: response.output });
							let parked = false;
							for (const call of calls) {
								/**
								 * A refusal is a tool result, not a dead turn.
								 *
								 * The model chooses tools from the offer it was shown; a collection-scoped agent
								 * (`collections: ['companies']`) is offered `read_collection` with no way to know
								 * the ceiling applies, so it is going to name the wrong collection sometimes. When
								 * it does, `requireCollection` answers `ToolNotAllowed` — and an agent-domain
								 * refusal like that is exactly the event the loop should hand back to the model
								 * ("that tool is not allowed, here is why"), so it can adapt its next move. Every
								 * other failure still aborts: a facility that broke is not something a second
								 * question can fix, and telling the model it happened would start a retry loop
								 * the tenant is paying for.
								 */
								const result = yield* executeTool(
									agent,
									call.name,
									call.input,
									EffectId.make(call.id),
									subject,
									conversationId
								).pipe(
									Effect.catch((failure) =>
										failure instanceof ToolNotAllowed || failure instanceof SkillError
											? Effect.succeed({ error: failure.message })
											: Effect.fail(failure)
									)
								);
								const encoded = yield* Schema.decodeUnknownEffect(
									Schema.fromJsonString(Schema.Json)
								)(JSON.stringify(result)).pipe(
									Effect.catch(() => Effect.succeed({ error: 'invalid-tool-result' }))
								);
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
						// the caller is waiting to be told about. The usage write joins it for the same reason it
						// runs below — a turn that failed after the model answered was still charged for.
						Effect.onError(() =>
							Effect.ignore(commit('failed').pipe(Effect.andThen(recordTurnUsage())))
						)
					);
					// A parked turn is still running — it resumes when the subagent answers — so only a turn that
					// reached an answer settles here.
					if (settled.status === 'completed') yield* commit('completed');
					yield* Effect.ignore(recordTurnUsage());
					// There is deliberately no continuation enqueued here.
					//
					// Every turn used to end by enqueueing `agents.resume { conversationId }`, into a facility
					// nothing executed. Made real, it would fire on two paths rather than one: a turn that
					// parked on a subagent, and a turn that exhausted `maxToolRounds` without an answer — and
					// the second continues, exhausts, continues, with nothing bounding it. That is a runaway
					// agent bill wearing a scheduler's clothes.
					//
					// It was also a duplicate carrying less information. `sandbox-tools.ts`'s
					// `await_sandbox_agent` already enqueues a resume for the parent, with the
					// `targetSessionId` that makes it actionable; this one named only the conversation. One
					// resume enqueue, one meaning.
					return { conversationId, output: settled.output, status: settled.status };
				}
			),
			/**
			 * Continuing a conversation that is waiting on a delegated subagent — the gap, stated.
			 *
			 * This did one thing and that thing no longer exists: it delivered a `Signal` to a parked task
			 * through a facility that never executed one. So a delegated turn parked and never woke, and
			 * the code read as though something was arranging otherwise.
			 *
			 * Making it real needs two things that are agent-domain changes rather than queue ones, and
			 * guessing at either would be worse than the gap. `turn` requires a `message`, and a
			 * continuation has none — passing an empty one appends an empty user message to the transcript
			 * that is the checkpoint for every future replay, which is a corruption and not a shortcut. And
			 * continuation has to be bounded, or a turn that ran out of tool rounds continues forever.
			 *
			 * Until both are answered this is honestly nothing, rather than dishonestly something.
			 */
			resume: Effect.fn('Agents.resume')(function* (_effectId, _taskId, _conversationId) {
				yield* Effect.void;
			}),
			cancel: Effect.fn('Agents.cancel')(function* (effectId, taskId) {
				yield* queue.cancel(effectId, taskId);
			}),
			updateVerifier: Effect.fn('Agents.updateVerifier')(
				function* (effectId, conversationId, verifier) {
					yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'update bolt_conversations set verifier = $2 where id = $1',
						parameters: [conversationId, verifier]
					});
				}
			),
			title: Effect.fn('Agents.title')(function* (effectId, conversationId) {
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'select title from bolt_conversations where id = $1',
					parameters: [conversationId]
				});
				const row = result.rows[0];
				const decoded = Schema.decodeUnknownOption(
					Schema.Struct({ title: Schema.optionalKey(Schema.String) })
				)(row);
				if (decoded._tag === 'Some' && decoded.value.title) return decoded.value.title;
				return 'New conversation';
			}),
			listConversations: Effect.fn('Agents.listConversations')(function* (effectId, subject) {
				// Delegated sessions are excluded: nobody started one and nobody can reply to it, and listing
				// them put a subagent's task prompt in the conversation picker as though it were a chat the
				// person had opened. They still reach the reader — inside the turn that spawned them.
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: "select id, agent_name, title from bolt_conversations where user_id = $1 and parent_id is null and id not like 'subagent:%' order by id desc",
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
					sql: 'select id, title, usage_cost_usd, usage_cost_micro_units, usage_cost_currency, usage_total_tokens, usage_turns_counted, usage_turns_unreported from bolt_conversations where id = $1 and user_id = $2',
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
				// Ordered by `sequence` across the whole tree rather than per session: the column is an
				// identity over the table, so one ordering already puts every session's own rows in the
				// order they were written, and the projection groups them by `turn_id` afterwards.
				const transcript = yield* database.execute(EffectId.make(`${effectId}:transcript`), {
					_tag: 'Query',
					sql: `with recursive tree as (
						select id, 0 as depth from bolt_conversations where id = $1
						union all
						select below.id, tree.depth + 1 from bolt_conversations below
							join tree on below.parent_id = tree.id
							where tree.depth < ${maxDelegationDepth}
					)
					select message.role, message.content, message.turn_id
						from bolt_agent_messages message
						join tree on tree.id = message.conversation_id
						order by message.sequence`,
					parameters: [conversationId]
				});
				return {
					conversationId,
					title: conversation.value.title ?? 'New conversation',
					messages: transcript.rows.flatMap((row) => {
						const decoded = Schema.decodeUnknownOption(MessageRow)(row);
						return decoded._tag === 'Some' ? [decoded.value] : [];
					}),
					usage: conversationUsage(owned.rows[0])
				};
			}),
			listSkills: Effect.fn('Agents.listSkills')(function* (agentName) {
				return (yield* workspace.agent(agentName)).skills;
			}),
			readSkill
		});
	})
);

export * as Agents from './agents.js';
