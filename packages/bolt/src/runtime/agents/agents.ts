import { Context, Effect, Layer, Ref, Schema } from 'effect';
import {
	addAIUsage,
	AIUsage,
	EffectId,
	readAIUsage,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import { AccessControl } from '../access/access-control.js';
import { ApprovalConflict } from '../approvals/approvals.js';
import { Collections, PendingApproval } from '../collections/collections.js';
import { AI, Connector, Files, HostTools } from '../facilities/services.js';
import { TaskQueue } from '../tasks/tasks.js';
import { Database } from '../facilities/database.js';
import { Identity } from '../identity/identity.js';
import { RemoteRegistry } from '../remotes.js';
import type { WhereCompileError } from '../collections/where.js';
import { DispatchError, Workspace, WorkspaceLookupError } from '../workspace.js';
import type { ToolDeclaration } from '../../authoring/workspace-schema.js';
import { WEB_AGENT_NAME } from '../../authoring/workspace-schema.js';

/**
 * The agent one turn runs as: the web agent, or one envoy.
 *
 * There is no declaration behind either. The web agent is defined entirely by *who is using it* —
 * it runs as the signed-in person, so their policies decide its tools, its collections and its
 * limits — and an envoy adds exactly one thing a policy cannot state, which is what it is for.
 *
 * `src/+agent.ts` used to sit here, carrying `tools`, `mcpServers`, `denyTools`, `hostTools`,
 * `collections`, `access`, `model` and `maxTokens`. Every one of those either duplicated a policy or
 * was a host default, and while it existed two people in one workspace were offered the same tools
 * however differently they were authorised.
 */
type ResolvedAgent = Readonly<{
	readonly name: string;
	/** The envoy's standing instruction, absent for the web agent. */
	readonly task?: string;
	/** `public` on an envoy anyone can message; absent for the web agent, which is never public. */
	readonly audience?: 'public' | 'authenticated';
}>;

/**
 * Which sandbox this turn works in — the tenant plane's counterpart to §10's personal plane.
 *
 * A person gets one tree, keyed by who they are. An envoy gets its own, keyed by the principal its
 * declaration mints. A **public** envoy gets one per conversation, and that partition is the whole
 * of §10.2: an envoy is one principal, so without it every sender on a public surface would share a
 * tree and a document a stranger uploaded would sit where the next stranger could read it.
 *
 * On an `authenticated` envoy the subject's `userId` has already narrowed to the matched member, so
 * the key is that member's and their sandbox is the one they have on the web — which is correct: it
 * is the same person, reached down a different wire.
 */
const sandboxKeyFor = (
	subject: Identity.Subject,
	agent: ResolvedAgent,
	conversationId: string
): string => (agent.audience === 'public' ? `${subject.userId}#${conversationId}` : subject.userId);
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
	resolve: (
		offered: ReadonlyArray<ToolDeclaration>,
		agentName: string,
		name: string
	): ToolDeclaration | ToolNotAllowed =>
		offered.find((tool) => tool.name === name) ??
		new ToolNotAllowed({ agent: agentName, tool: name }),
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

const TurnStatus = Schema.Literals(['running', 'completed', 'failed', 'cancelled']);
type TurnStatus = Schema.Schema.Type<typeof TurnStatus>;

/**
 * Everything a parked turn needs in order to continue under the authority that started it.
 *
 * The subject is a snapshot, deliberately. A task invocation carries no credential, and rebuilding a
 * subject from `bolt_conversations.user_id` would be both incomplete (there is no team path there)
 * and wrong for envoys (their policies are static authority, not the linked person's authority).
 */
const StoredTurn = Schema.Struct({
	id: Schema.NonEmptyString,
	status: TurnStatus,
	subagent_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	parts: Schema.Array(TurnPart),
	resumed: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
	),
	subject: Schema.optionalKey(Identity.Subject),
	agent_name: Schema.optionalKey(Schema.NonEmptyString),
	sender_context: Schema.optionalKey(Schema.String),
	usage: Schema.optionalKey(AIUsage),
	usage_unreported: Schema.optionalKey(Schema.Boolean)
});
type StoredTurn = Schema.Schema.Type<typeof StoredTurn>;

const StoredTurnRow = Schema.Struct({ content: StoredTurn });
const AwaitInput = Schema.Struct({ sessionId: Schema.NonEmptyString });
const WaitingAnswer = Schema.Struct({ waiting: Schema.Literal(true) });

/** A completed delegated turn, returned to the parent as the answer to its await tool call. */
const SettledTarget = Schema.Struct({
	id: Schema.NonEmptyString,
	status: Schema.Literals(['completed', 'failed', 'cancelled']),
	parts: Schema.Array(TurnPart)
});
const SettledTargetRow = Schema.Struct({ content: SettledTarget });

const maxResumes = 4;

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
	status: Schema.Literals(['completed', 'waiting', 'failed'])
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
		conversationId: string,
		targetSessionId: string
	) => Effect.Effect<
		void,
		| Workspace.WorkspaceLookupError
		| AccessControl.AccessDenied
		| Database.FacilityError
		| SkillError
		| ToolNotAllowed
		| ApprovalConflict
		| PendingApproval
		| WhereCompileError
		| AuthoredRefusal
		| InvocationBudget.NestingLimitExceeded
	>;
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
	/**
	 * The skills this subject may load — its policies', not an agent declaration's.
	 *
	 * It takes a subject rather than an agent name because a skill is capability: two people on the
	 * same web agent are offered different skills, and asking by agent name could not express that.
	 */
	readonly listSkills: (subject: Identity.Subject) => ReadonlyArray<string>;
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
		 * The tools one turn is offered, decided by the subject's policies and nothing else.
		 *
		 * This is the whole of §5 in one function: two people in one workspace get different tools on
		 * the *same* web agent because they hold different policies, and an envoy gets what its
		 * declared policies name. Adding a `capabilities/tools/+<name>.ts` file widens **nobody** until
		 * a policy names it.
		 *
		 * It replaces four fields on a declaration none of which were enforced. The funnel returned the
		 * platform set, the sandbox set and every workspace tool unconditionally, so a workspace that
		 * declared `access: 'read'` shipped an agent holding `write_collection` and one that named
		 * `denyTools` shipped an agent holding all of them.
		 *
		 * `write_collection` follows the grants, which is the honest reading of "may this subject
		 * write": a policy that grants no `create`, `update` or `delete` on anything has said the
		 * holder does not write, and offering the tool anyway only moves the refusal later. `access:
		 * 'read' | 'write'` was a second, coarser way of saying the same thing, in a place a reviewer
		 * comparing it against the grants would not look.
		 *
		 * Sandbox tools are offered unconditionally and deliberately. A sandbox is per-principal and
		 * holds no workspace data (§10), so reaching one grants nothing; withholding it was what
		 * `denyTools` claimed to do and could not, because an agent that could hide its own siblings
		 * could hide what it did with them.
		 */
		const allowedTools = (subject: Identity.Subject): ReadonlyArray<ToolDeclaration> => {
			const granted = access.capabilities(subject);
			const mayWrite = writesForSubject(subject);
			const authored = workspace.definition.tools.filter((tool) => granted.tools.has(tool.name));
			const authoredNames = new Set(authored.map(({ name }) => name));
			const platform = platformToolSpecs
				.filter((tool) => !authoredNames.has(tool.name))
				.filter((tool) => tool.name !== 'write_collection' || mayWrite);
			return [
				...platform,
				...sandboxToolSpecs.filter((tool) => !authoredNames.has(tool.name)),
				...authored
			];
		};

		/**
		 * Whether any policy this subject holds grants a write on anything at all.
		 *
		 * The gate on `write_collection`, read off the grants rather than off a separate `access`
		 * field. A subject with no write grant anywhere cannot succeed at a write, so offering the tool
		 * would only teach the model to try.
		 */
		const writesForSubject = (subject: Identity.Subject): boolean =>
			workspace.definition.collections.some((collection) =>
				(['create', 'update', 'delete'] as const).some(
					(action) => access.explain(subject, action, collection.name).allowed
				)
			);

		/**
		 * Whether an MCP tool name reaches a server this subject may call.
		 *
		 * An allowlist, with no "absent means every server" arm. That arm existed because a workspace
		 * declaring `+<name>.mcp.ts` files and no `+agent.ts` would otherwise lose every server it
		 * authored to a field it never wrote — which was a symptom of capability living somewhere a
		 * workspace could forget to fill in. A policy is the only place capability is declared now, so
		 * an unnamed server is a server nobody granted.
		 */
		const mcpAllowed = (subject: Identity.Subject, server: string): boolean =>
			access.capabilities(subject).mcp.has(server);

		/**
		 * The agent a turn is for: the web agent, or one declared envoy.
		 *
		 * `web` is reserved at authoring time (`envoy()` refuses it) so this cannot be shadowed, and it
		 * needs no declaration to resolve because there is nothing in one. Anything else must be a
		 * declared envoy — a name that is neither is a refusal, reported as an access denial rather
		 * than a lookup failure because from the caller's side "no such agent" and "not yours" are the
		 * same answer and the difference is worth not disclosing.
		 */
		const resolveAgent = Effect.fn('Agents.resolveAgent')(function* (agentName: string) {
			if (agentName === WEB_AGENT_NAME) return { name: WEB_AGENT_NAME } satisfies ResolvedAgent;
			const envoy = workspace.definition.envoys.find(({ name }) => name === agentName);
			if (envoy === undefined) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: agentName,
					reason: 'unknown agent'
				});
			}
			return {
				name: envoy.name,
				task: envoy.task,
				audience: envoy.audience
			} satisfies ResolvedAgent;
		});

		/**
		 * The conversation row a turn writes into, carrying what kind of thread it is.
		 *
		 * `visibility` and `envoy_key` were read by `conversation-selector.ts` and written by nothing:
		 * neither column existed, so `visibility` was always `undefined`, the group bucket was
		 * permanently empty, and a public envoy's threads never reached the admin inbox they were
		 * routed to. Both are populated here, at the one place a conversation is opened.
		 *
		 * `user_id` is the sandbox key rather than the raw subject id, so a public envoy's per-sender
		 * partition is a property of the row rather than a rule every reader has to remember.
		 */
		const openConversation = Effect.fn('Agents.openConversation')(function* (
			effectId: EffectIdType,
			agent: ResolvedAgent,
			subject: Identity.Subject,
			conversationId: string
		) {
			const group = conversationId.includes(':group:');
			yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'insert into bolt_conversations (id, agent_name, user_id, visibility, envoy_key) values ($1, $2, $3, $4, $5) on conflict do nothing',
				parameters: [
					conversationId,
					agent.name,
					sandboxKeyFor(subject, agent, conversationId),
					agent.name === WEB_AGENT_NAME ? 'personal' : group ? 'envoy_group' : 'envoy_dm',
					agent.name === WEB_AGENT_NAME ? null : agent.name
				]
			});
		});

		const executeTool = Effect.fn('Agents.executeTool')(function* (
			agent: ResolvedAgent,
			name: string,
			input: Schema.Json,
			effectId: EffectIdType,
			subject: Identity.Subject,
			conversationId: string
		) {
			const sandboxKey = sandboxKeyFor(subject, agent, conversationId);
			const allowlist = allowedTools(subject);
			const mcp = AgentTools.parseMcpName(name);
			const offered = allowlist.some((tool) => tool.name === name);
			// A platform or sandbox name was admitted on the strength of being one, which made `denyTools`
			// and `access` advisory: an agent that was never offered `write_collection` could still call
			// it by name. The allowlist is the answer for every kind now, and an MCP call is admitted only
			// when a policy this subject holds named that server.
			if (
				!offered &&
				!isSandboxTool(name) &&
				!(mcp !== undefined && mcpAllowed(subject, mcp.server))
			) {
				return yield* new ToolNotAllowed({ agent: agent.name, tool: name });
			}
			const context = {
				effectId,
				subject,
				agentName: agent.name,
				// The skills this subject's policies grant, not a list an agent declaration carried. A
				// skill is capability, so it is granted where every other capability is.
				skills: [...access.capabilities(subject).skills],
				toolNames: allowlist.map(({ name: tool }) => tool),
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
					sandboxKey,
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
			// The host-tools funnel, reached by a name the allowlist offered and nothing else resolved.
			// `hostTools` — an opt-in list on the agent declaration, declared by no workspace and read by
			// nothing until it was wired up — is gone with the declaration; a host tool is admitted here
			// because a policy named it, like everything else.
			const declared = allowlist.find((tool) => tool.name === name);
			if (name.startsWith('sandbox_') || declared?.command.startsWith('host:') === true) {
				return yield* executeHostTool(name, input, context);
			}
			return yield* new ToolNotAllowed({ agent: agent.name, tool: name });
		});

		/** The exact tool offer a turn presents, including the collections its grants can reach. */
		const toolsFor = (subject: Identity.Subject): ReadonlyArray<Schema.Json> => {
			const reachable = (action: 'read' | 'write'): ReadonlyArray<string> =>
				workspace.definition.collections
					.filter(({ name }) =>
						action === 'read'
							? access.explain(subject, 'read', name).allowed
							: (['create', 'update', 'delete'] as const).some(
									(write) => access.explain(subject, write, name).allowed
								)
					)
					.map(({ name }) => name);
			return allowedTools(subject).map(({ name, description, command }) => {
				if (name !== 'read_collection' && name !== 'write_collection')
					return { name, description, command };
				const allowed = reachable(name === 'read_collection' ? 'read' : 'write');
				return {
					name,
					description:
						allowed.length === 0
							? description
							: `${description} Allowed collections: ${allowed.join(', ')}.`,
					command
				};
			});
		};

		/** Replays stored rows into the provider prompt used by both a new and a resumed turn. */
		const promptFor = (
			agent: ResolvedAgent,
			rows: ReadonlyArray<unknown>,
			senderContext?: string
		): Array<Schema.Json> => [
			{ role: 'system', content: workspace.definition.prompt },
			...(agent.task === undefined ? [] : [{ role: 'system', content: agent.task } as Schema.Json]),
			...(senderContext === undefined
				? []
				: [{ role: 'system', content: senderContext } as Schema.Json]),
			...rows.flatMap((row): ReadonlyArray<Schema.Json> => {
				const decoded = Schema.decodeUnknownOption(MessageRow)(row);
				if (decoded._tag === 'None') return [];
				const relayed = parseAgentMessage(decoded.value.content);
				if (relayed !== null) return [{ role: 'user', content: agentMessageForModel(relayed) }];
				const whole = Schema.decodeUnknownOption(Schema.Struct({ parts: Schema.Array(TurnPart) }))(
					decoded.value.content
				);
				return whole._tag === 'Some' ? replayTurn(whole.value.parts) : [decoded.value];
			})
		];

		/** Adds one usage delta to this session and every parent session above it. */
		const recordUsage = Effect.fn('Agents.recordUsage')(function* (
			effectId: EffectIdType,
			conversationId: string,
			usage: AIUsage | undefined,
			turnsCounted: number,
			turnsUnreported: number
		) {
			yield* database.execute(effectId, {
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
					usage_turns_counted = usage_turns_counted + $6,
					usage_turns_unreported = usage_turns_unreported + $7
				where id in (select id from lineage)`,
				parameters: [
					conversationId,
					usage?.costUsd ?? 0,
					Math.round(usage?.costMicroUnits ?? 0),
					usage?.costCurrency ?? null,
					Math.round(usage?.totalTokens ?? 0),
					turnsCounted,
					turnsUnreported
				]
			});
		});

		/**
		 * Enqueues the parent continuation only after this delegated session has durably settled.
		 *
		 * Enqueueing from `await_sandbox_agent` races the child: the queue can run the continuation while
		 * the child is still `running`. Settlement is the event that makes the input actionable, and the
		 * key makes a replay of that settlement one enqueue.
		 */
		const resumeParent = Effect.fn('Agents.resumeParent')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const parent = yield* database.execute(EffectId.make(`${effectId}:read-parent`), {
				_tag: 'Query',
				sql: 'select parent_id from bolt_conversations where id = $1',
				parameters: [conversationId]
			});
			const decoded = Schema.decodeUnknownOption(
				Schema.Struct({ parent_id: Schema.Union([Schema.String, Schema.Null]) })
			)(parent.rows[0]);
			const parentId = decoded._tag === 'Some' ? decoded.value.parent_id : null;
			if (parentId === null) return;
			const enqueueId = EffectId.make(`${effectId}:resume-parent`);
			yield* queue.enqueue(enqueueId, [
				{
					command: 'agents.resume',
					input: { conversationId: parentId, targetSessionId: conversationId },
					effectId: enqueueId
				}
			]);
		});

		type CommitTurn = (
			status: TurnStatus,
			usage: AIUsage | undefined,
			usageUnreported: boolean
		) => Effect.Effect<unknown, Database.FacilityError>;
		type SettleUsage = (
			usage: AIUsage | undefined,
			newlyUnreported: boolean
		) => Effect.Effect<unknown, Database.FacilityError>;

		/** Runs one bounded segment of a turn, shared by its first invocation and every continuation. */
		const continueToolLoop = Effect.fn('Agents.continueToolLoop')(function* (
			namespace: EffectIdType,
			agent: ResolvedAgent,
			subject: Identity.Subject,
			conversationId: string,
			messages: Array<Schema.Json>,
			tools: ReadonlyArray<Schema.Json>,
			parts: Array<TurnPart>,
			initialUsage: AIUsage | undefined,
			initialUsageUnreported: boolean,
			commit: CommitTurn,
			settleUsage: SettleUsage
		) {
			const usage = yield* Ref.make({
				cumulative: initialUsage,
				segment: undefined as AIUsage | undefined,
				unreported: initialUsageUnreported
			});
			const run = Effect.gen(function* () {
				let output: Schema.Json = null;
				// Exhausting the bound is a terminal failure, never another unowned parked turn.
				let status: 'completed' | 'waiting' | 'failed' = 'failed';
				for (let round = 0; round < maxToolRounds; round += 1) {
					const response = yield* ai.execute(EffectId.make(`${namespace}:ai:${round}`), {
						_tag: 'Turn',
						model: 'default',
						messages,
						tools,
						maxOutputTokens: 2048
					});
					output = response.output;
					const reported = readAIUsage(response.usage);
					yield* Ref.update(usage, (current) => ({
						cumulative: addAIUsage(current.cumulative, reported),
						segment: addAIUsage(current.segment, reported),
						unreported: current.unreported || reported === undefined
					}));
					const decoded = Schema.decodeUnknownOption(TurnOutput)(response.output);
					const toolCalls = decoded._tag === 'Some' ? (decoded.value.toolCalls ?? []) : [];
					const text = decoded._tag === 'Some' ? decoded.value.text : undefined;
					if (toolCalls.length === 0) {
						status = 'completed';
						parts.push({ kind: 'text', text: text ?? '' });
						const current = yield* Ref.get(usage);
						yield* commit('running', current.cumulative, current.unreported);
						break;
					}
					const calls = toolCalls.map((call, index) => ({
						id: `${namespace}:tool:${round}:${index}`,
						name: call.name,
						input: call.input ?? null
					}));
					if (text !== undefined && text.trim().length > 0) {
						parts.push({ kind: 'text', text });
						const current = yield* Ref.get(usage);
						yield* commit('running', current.cumulative, current.unreported);
					}
					messages.push({ role: 'assistant', content: response.output });
					let parked = false;
					for (const call of calls) {
						parts.push({ kind: 'tool', id: call.id, name: call.name, input: call.input });
						const beforeCall = yield* Ref.get(usage);
						yield* commit('running', beforeCall.cumulative, beforeCall.unreported);
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
						const encoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
							JSON.stringify(result)
						).pipe(Effect.catch(() => Effect.succeed({ error: 'invalid-tool-result' })));
						parts.push({ kind: 'tool-result', id: call.id, name: call.name, output: encoded });
						const afterCall = yield* Ref.get(usage);
						yield* commit('running', afterCall.cumulative, afterCall.unreported);
						messages.push({
							role: 'tool',
							name: call.name,
							content: JSON.stringify(encoded)
						});
						const waiting = Schema.decodeUnknownOption(WaitingAnswer)(encoded);
						// `spawn_subagent` starts work; only the explicit join point parks its caller.
						if (call.name === 'await_sandbox_agent' && waiting._tag === 'Some') {
							output = encoded;
							status = 'waiting';
							parked = true;
							break;
						}
					}
					if (parked) break;
				}
				const current = yield* Ref.get(usage);
				return { output, status, ...current };
			});

			return yield* run.pipe(
				Effect.onError(() =>
					Effect.gen(function* () {
						const current = yield* Ref.get(usage);
						yield* Effect.ignore(commit('failed', current.cumulative, current.unreported));
						yield* Effect.ignore(
							settleUsage(current.segment, current.unreported && !initialUsageUnreported)
						);
					})
				)
			);
		});

		return Service.of({
			start: Effect.fn('Agents.start')(function* (effectId, subject, agentName, conversationId) {
				const agent = yield* resolveAgent(agentName);
				yield* access.authorize(subject, 'agent', agentName);
				yield* openConversation(effectId, agent, subject, conversationId);
			}),
			// stupidity:allow Q3 -- the tool loop and the records it writes are one unit of meaning
			turn: Effect.fn('Agents.turn')(
				function* (effectId, subject, agentName, conversationId, message, senderContext) {
					const agent = yield* resolveAgent(agentName);
					yield* access.authorize(subject, 'agent', agentName);
					yield* openConversation(
						EffectId.make(`${effectId}:ensure-conversation`),
						agent,
						subject,
						conversationId
					);
					const transcript = yield* database.execute(EffectId.make(`${effectId}:read`), {
						_tag: 'Query',
						sql: 'select role, content from bolt_agent_messages where conversation_id = $1 order by sequence',
						parameters: [conversationId]
					});
					const tools = toolsFor(subject);
					const messages: Array<Schema.Json> = [
						...promptFor(agent, transcript.rows, senderContext),
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
					const commit: CommitTurn = (status, usage, usageUnreported) =>
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
									resumed: 0,
									subject,
									agent_name: agent.name,
									...(senderContext === undefined ? {} : { sender_context: senderContext }),
									...(usage === undefined ? {} : { usage }),
									usage_unreported: usageUnreported
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
						parts: [],
						resumed: 0,
						subject,
						agent_name: agent.name,
						...(senderContext === undefined ? {} : { sender_context: senderContext }),
						usage_unreported: false
					});
					const settleUsage: SettleUsage = (usage, newlyUnreported) =>
						recordUsage(
							EffectId.make(`${effectId}:usage`),
							conversationId,
							usage,
							1,
							newlyUnreported ? 1 : 0
						);
					const settled = yield* continueToolLoop(
						effectId,
						agent,
						subject,
						conversationId,
						messages,
						tools,
						parts,
						undefined,
						false,
						commit,
						settleUsage
					);
					if (settled.status !== 'waiting') {
						yield* commit(settled.status, settled.cumulative, settled.unreported);
					}
					yield* Effect.ignore(settleUsage(settled.segment, settled.unreported));
					if (settled.status !== 'waiting') {
						yield* resumeParent(effectId, conversationId);
					}
					return { conversationId, output: settled.output, status: settled.status };
				}
			),
			resume: Effect.fn('Agents.resume')(function* (effectId, conversationId, targetSessionId) {
				/**
				 * Authority is structural first: the target must be this conversation's child and both rows
				 * must belong to the same sandbox. A task carries no credential, so accepting either id by
				 * itself would make the internal command a cross-conversation transcript reader.
				 */
				const relationship = yield* database.execute(EffectId.make(`${effectId}:authorize`), {
					_tag: 'Query',
					sql: `select target.parent_id, target.user_id as target_user_id,
							parent.user_id as parent_user_id
						from bolt_conversations target
						join bolt_conversations parent on parent.id = $1
						where target.id = $2 and target.parent_id = parent.id
							and target.user_id = parent.user_id`,
					parameters: [conversationId, targetSessionId]
				});
				const authorized = Schema.decodeUnknownOption(
					Schema.Struct({
						parent_id: Schema.String,
						target_user_id: Schema.String,
						parent_user_id: Schema.String
					})
				)(relationship.rows[0]);
				if (
					authorized._tag === 'None' ||
					authorized.value.parent_id !== conversationId ||
					authorized.value.target_user_id !== authorized.value.parent_user_id
				) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: targetSessionId,
						reason: 'target is not a delegated session of this conversation'
					});
				}

				const targetResult = yield* database.execute(EffectId.make(`${effectId}:target`), {
					_tag: 'Query',
					sql: `select content from bolt_agent_messages
						where conversation_id = $1 and role = 'assistant'
							and content->>'status' in ('completed', 'failed', 'cancelled')
						order by sequence desc limit 1`,
					parameters: [targetSessionId]
				});
				const target = Schema.decodeUnknownOption(SettledTargetRow)(targetResult.rows[0]);
				if (target._tag === 'None') {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: targetSessionId,
						reason: 'target session has not settled'
					});
				}

				const parkedResult = yield* database.execute(EffectId.make(`${effectId}:parked`), {
					_tag: 'Query',
					sql: `select content from bolt_agent_messages
						where conversation_id = $1 and role = 'assistant'
							and content->>'status' = 'running'
						order by sequence desc limit 1`,
					parameters: [conversationId]
				});
				const parked = Schema.decodeUnknownOption(StoredTurnRow)(parkedResult.rows[0]);
				// A replay after the parent settled is an idempotent no-op.
				if (parked._tag === 'None') return;
				const stored = parked.value.content;
				if (stored.subject === undefined || stored.agent_name === undefined) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'parked turn has no continuation authority'
					});
				}
				const agent = yield* resolveAgent(stored.agent_name);
				yield* access.authorize(stored.subject, 'agent', stored.agent_name);

				const parts = [...stored.parts];
				let answerIndex = -1;
				let waiting = false;
				for (let index = parts.length - 1; index >= 0; index -= 1) {
					const answer = parts[index];
					if (answer?.kind !== 'tool-result' || answer.name !== 'await_sandbox_agent') continue;
					const call = parts.find(
						(part) => part.kind === 'tool' && part.id === answer.id && part.name === answer.name
					);
					if (call?.kind !== 'tool') continue;
					const input = Schema.decodeUnknownOption(AwaitInput)(call.input);
					if (input._tag === 'None' || input.value.sessionId !== targetSessionId) continue;
					answerIndex = index;
					waiting = Schema.decodeUnknownOption(WaitingAnswer)(answer.output)._tag === 'Some';
					break;
				}
				// A stale settlement for a different child cannot wake whichever child is currently awaited.
				if (answerIndex < 0) return;
				const alreadyResumed = stored.resumed ?? 0;
				const resumed = alreadyResumed + (waiting && alreadyResumed < maxResumes ? 1 : 0);
				const namespace = EffectId.make(`${stored.id}:resume:${resumed}`);
				let committed = 0;
				const commit: CommitTurn = (status, usage, usageUnreported) =>
					database.execute(EffectId.make(`${effectId}:turn:${(committed += 1)}`), {
						_tag: 'Query',
						sql: "update bolt_agent_messages set content = $3::jsonb where conversation_id = $1 and content->>'id' = $2 and content->>'status' = 'running'",
						parameters: [
							conversationId,
							stored.id,
							JSON.stringify({
								...stored,
								status,
								parts,
								resumed,
								...(usage === undefined ? {} : { usage }),
								usage_unreported: usageUnreported
							})
						]
					});

				if (waiting && alreadyResumed >= maxResumes) {
					yield* commit('failed', stored.usage, stored.usage_unreported ?? false);
					yield* resumeParent(namespace, conversationId);
					return;
				}
				if (waiting) {
					const previous = parts[answerIndex];
					if (previous?.kind !== 'tool-result') return;
					parts[answerIndex] = {
						...previous,
						output: { waiting: false, output: target.value.content }
					};
					yield* commit('running', stored.usage, stored.usage_unreported ?? false);
				}

				const transcript = yield* database.execute(EffectId.make(`${effectId}:read`), {
					_tag: 'Query',
					sql: 'select role, content from bolt_agent_messages where conversation_id = $1 order by sequence',
					parameters: [conversationId]
				});
				const settleUsage: SettleUsage = (usage, newlyUnreported) =>
					recordUsage(
						EffectId.make(`${namespace}:usage`),
						conversationId,
						usage,
						0,
						newlyUnreported ? 1 : 0
					);
				const settled = yield* continueToolLoop(
					namespace,
					agent,
					stored.subject,
					conversationId,
					promptFor(agent, transcript.rows, stored.sender_context),
					toolsFor(stored.subject),
					parts,
					stored.usage,
					stored.usage_unreported ?? false,
					commit,
					settleUsage
				);
				if (settled.status !== 'waiting') {
					yield* commit(settled.status, settled.cumulative, settled.unreported);
				}
				yield* Effect.ignore(
					settleUsage(settled.segment, settled.unreported && !(stored.usage_unreported ?? false))
				);
				if (settled.status !== 'waiting') {
					yield* resumeParent(namespace, conversationId);
				}
			}),
			cancel: Effect.fn('Agents.cancel')(function* (effectId, taskId) {
				yield* queue.cancel(EffectId.make(`${effectId}:task`), taskId);
				yield* database.execute(EffectId.make(`${effectId}:turn`), {
					_tag: 'Query',
					sql: `update bolt_agent_messages
						set content = jsonb_set(content, '{status}', '"cancelled"'::jsonb, true)
						where content->>'id' = $1 and content->>'status' = 'running'`,
					parameters: [taskId]
				});
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
			listSkills: (subject) =>
				workspace.definition.skills.filter((name) => access.capabilities(subject).skills.has(name)),
			readSkill
		});
	})
);

export * as Agents from './agents.js';
