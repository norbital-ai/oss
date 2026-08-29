/**
 * How one synced `chat_message` row reads in the panel.
 *
 * The loop stores one turn per row and its steps as the parts inside it, so this is a projection of
 * the stored turn and not a second model of the conversation. Kept out of the component because it is the only part
 * with an answer worth checking, and this package has no browser runner to check it through one.
 */
import { Effect, Option, Schema } from 'effect';
import {
	parseStoredGoalVerdict,
	parseStoredVerifierScheduled
} from '#lib/client/ui/agent/goal-verdict.js';
import { parseAgentMessage } from '#lib/runtime/agents/agent-message.js';
import { chatInputForModel, parseStoredChatInput } from '#lib/runtime/agents/chat-messages.js';
import { humanize } from '@norbital-ai/std';
import { parseStoredSummary } from '#lib/client/ui/agent/intent.js';

function parsePublicMcpToolName(
	name: string
): { readonly server: string; readonly tool: string } | null {
	const index = name.indexOf(':');
	if (index === -1) return null;
	return { server: name.slice(0, index), tool: name.slice(index + 1) };
}

// repository-health:allow AL8 -- a rendering view-model, not a message shape: `kind` and `key` are
// panel concerns with no wire meaning, and this package exports no canonical message
// type to compose from (`MessageRow` is a private Schema.Struct with a different field set).
type PanelText = {
	readonly kind: 'text';
	readonly key: string;
	readonly role: string;
	readonly content: string;
};

/** One provider reasoning part, intentionally separate from the answer and collapsed in the UI. */
type PanelReasoning = {
	readonly kind: 'reasoning';
	readonly key: string;
	readonly content: string;
};

/**
 * One call the agent made, with the answer it got back.
 *
 * A turn can call the same tool twice; the loop writes both into one assistant row and each answer
 * into a row of its own. Naming them in a joined string ("read_collection, read_collection") loses
 * which arguments produced which rows, so a call is the unit here rather than the row that carried
 * it.
 */
type PanelToolCall = {
	readonly kind: 'tool';
	readonly key: string;
	/** Registered name, kept verbatim — tenant and host tools are not in the label table. */
	readonly name: string;
	/**
	 * Catalog key for a built-in tool label, or `null` when the tool is not one
	 * Bolt ships — those render the humanized name in `label` instead.
	 */
	readonly labelKey: string | null;
	/** Humanized fallback label, used only when `labelKey` is null. */
	readonly label: string | null;
	readonly icon: string;
	/** The one argument worth reading at a glance, so two calls to one tool differ on sight. */
	readonly detail: string | null;
	readonly input: string | null;
	readonly output: string | null;
	readonly error: string | null;
	readonly state: 'running' | 'complete' | 'failed' | 'needs_input';
	readonly elicitation:
		| readonly {
				readonly id: string;
				readonly message: string;
				readonly mode?: 'form' | 'url';
				readonly url?: string;
		  }[]
		| null;
	/** Sandbox IPC and MCP are first-class families, not generic wrenches. */
	readonly family: 'sandbox' | 'mcp' | null;
	/**
	 * The delegated agent's own transcript, projected the same way this one was.
	 *
	 * Empty for every tool but `spawn_agent`. A child has its own conversation, but its transcript is
	 * rendered beneath the spawn call so the hierarchy remains visible without exposing it as a root
	 * conversation in the selector.
	 */
	readonly children: readonly PanelMessage[];
};

/**
 * One message between two agent sessions, in whichever direction this transcript saw it.
 *
 * A received message is stored in the `user` role because that is the only role a session accepts
 * for words it did not produce, and projected as text it renders in the reader's own bubble under
 * their own name — a conversation they were never part of, attributed to them. An outgoing one is a
 * tool call whose message body sits inside the arguments blob, which says a message was sent without
 * showing what was said. Both are the same event and it is a message, so it is a row of its own.
 */
type PanelAgentMessage = {
	readonly kind: 'agent-message';
	readonly key: string;
	/** `in` when this session received it, `out` when it sent it. */
	readonly direction: 'in' | 'out';
	/** The other session: its agent, its title, its id — as much as was recorded. */
	readonly agentName: string | null;
	readonly sessionTitle: string | null;
	readonly agentId: string | null;
	readonly content: string;
	/** Delivery, for a message being sent. One that arrived is `complete` by definition. */
	readonly state: 'running' | 'complete' | 'failed';
	readonly error: string | null;
};

/**
 * A point where the conversation was replaced, for the model, by a summary of itself.
 *
 * Rendered rather than hidden because the alternative is history that vanishes with no mark. `before`
 * is the whole prefix, not the slice since the previous checkpoint: nothing was deleted, so showing
 * all of it costs nothing, and a summary of a summary with no path back to the original is the
 * failure this exists to prevent.
 */
type PanelCheckpoint = {
	readonly kind: 'checkpoint';
	readonly key: string;
	readonly summary: string;
	readonly before: readonly PanelMessage[];
	/** Why this checkpoint exists. Plan folds use the same disclosure as compaction. */
	readonly fold: 'plan' | 'compact';
};

/** Independent verifier result for a goal-mode turn. Not the agent's own claim. */
type PanelGoal = {
	readonly kind: 'goal';
	readonly key: string;
	readonly achieved: boolean;
	readonly summary: string;
	readonly gaps: readonly string[];
};

/** End-action scheduled for this turn. The person can edit the prompt before it runs. */
type PanelVerifier = {
	readonly kind: 'verifier';
	readonly key: string;
	readonly prompt: string;
};

export type PanelMessage =
	| PanelText
	| PanelReasoning
	| PanelToolCall
	| PanelAgentMessage
	| PanelCheckpoint
	| PanelGoal
	| PanelVerifier;

/** One typed `chat_message` row, with only its intentionally untyped jsonb content left to decode. */
// repository-health:allow AL8 -- a structural projection of the row, so `projectStoredChatMessages`
// is testable without the generated client; declaring the canonical type this rule asks for would
// itself be a matching type literal.
type StoredChatMessageRow = Readonly<{
	readonly id: string;
	readonly conversation_id: string;
	readonly turn_id: string | null;
	readonly role: string;
	readonly content: unknown;
}>;

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const JsonObjects = Schema.Array(JsonObject);
const ElicitationRequest = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	message: Schema.String,
	mode: Schema.optionalKey(Schema.Literals(['form', 'url'])),
	url: Schema.optionalKey(Schema.String)
});
const StoredTurn = Schema.Struct({
	id: Schema.String,
	status: Schema.String,
	parent_agent_id: Schema.NullOr(Schema.String),
	parts: Schema.Array(JsonObject),
	usage: Schema.optionalKey(JsonObject),
	error: Schema.optionalKey(Schema.String)
});
const StoredText = Schema.Union([Schema.String, Schema.Struct({ text: Schema.String })]);
const decodeStoredTurn = Schema.decodeUnknownOption(StoredTurn);
const decodeStoredText = Schema.decodeUnknownOption(StoredText);
const decodeJsonObject = Schema.decodeUnknownOption(JsonObject);
const decodeJsonObjects = Schema.decodeUnknownOption(JsonObjects);
const decodeElicitationRequest = Schema.decodeUnknownOption(ElicitationRequest);
const emptyJsonObject = (): typeof JsonObject.Type => ({});

/**
 * Projects the typed, reactive `chat_message` query into the transcript's presentation records.
 *
 * Only `content` is decoded: it is the model's deliberate jsonb payload. Collection columns are
 * already typed by `PlatformSchema`, so this function never re-checks or widens them.
 */
export function projectStoredChatMessages(rows: readonly StoredChatMessageRow[]) {
	const projected = rows.map((row) => {
		const chatInput = parseStoredChatInput(row.content);
		if (chatInput !== null) {
			return {
				id: row.id,
				conversation_id: row.conversation_id,
				role: row.role,
				parts: [{ kind: 'text', text: chatInputForModel(chatInput) }],
				turn_id: row.turn_id
			};
		}
		const relayed = parseAgentMessage(row.content);
		if (relayed !== null) {
			return {
				id: row.id,
				conversation_id: row.conversation_id,
				kind: relayed.kind,
				role: row.role,
				from: relayed.from,
				parts: [{ kind: 'text', text: relayed.text }],
				turn_id: row.turn_id
			};
		}
		return Option.match(decodeStoredTurn(row.content), {
			onNone: () => {
				const content = Option.getOrElse(decodeStoredText(row.content), () => '');
				return {
					id: row.id,
					conversation_id: row.conversation_id,
					role: row.role,
					parts: [{ kind: 'text', text: typeof content === 'string' ? content : content.text }],
					turn_id: row.turn_id
				};
			},
			onSome: (turn) => ({
				...turn,
				conversation_id: row.conversation_id,
				role: row.role,
				turn_id: row.turn_id
			})
		});
	});
	const turns = rows.flatMap((row) =>
		Option.match(decodeStoredTurn(row.content), {
			onNone: () => [],
			onSome: ({ id, status, parent_agent_id, error }) => [
				{
					id,
					conversation_id: row.conversation_id,
					status,
					parent_agent_id,
					...(error === undefined ? {} : { error })
				}
			]
		})
	);
	const delegatedTurnIds = new Set(
		turns.filter((turn) => turn.parent_agent_id !== null).map((turn) => turn.id)
	);
	return {
		messages: projected.map((record) => ({
			...record,
			...(record.turn_id !== null && delegatedTurnIds.has(record.turn_id)
				? { delegated: true }
				: {})
		})),
		turns
	};
}

/**
 * Tool payloads are held behind a disclosure and capped.
 *
 * `read_collection` answers with every policy-visible row it was asked for. That is the reader's own
 * tenant data rather than a leak, but pasting a hundred records into a conversation buries the
 * conversation, and the panel scroller has to lay all of it out. Capping the text keeps an expanded
 * call readable and bounds what one row can cost.
 */
const PAYLOAD_LIMIT = 2_000;

type ToolMetadata = { readonly labelKey: string | null; readonly icon: string };

const TOOL_METADATA: Readonly<Record<string, ToolMetadata>> = {
	describe_workspace: { labelKey: 'bolt.agent.tool.describeWorkspace', icon: 'lucide:book-open' },
	read_collection: { labelKey: 'bolt.agent.tool.readCollection', icon: 'lucide:table' },
	write_collection: { labelKey: 'bolt.agent.tool.writeCollection', icon: 'lucide:database' },
	spawn_agent: { labelKey: 'bolt.agent.tool.spawnAgent', icon: 'lucide:network' },
	list_skills: { labelKey: 'bolt.agent.tool.listSkills', icon: 'lucide:library' },
	read_skill: { labelKey: 'bolt.agent.tool.readSkill', icon: 'lucide:book-marked' },
	list_agents: { labelKey: 'bolt.agent.tool.listAgents', icon: 'lucide:users' },
	read_agent: { labelKey: 'bolt.agent.tool.readAgent', icon: 'lucide:scan-search' },
	message_agent: { labelKey: 'bolt.agent.tool.messageAgent', icon: 'lucide:send' },
	await_agent: { labelKey: 'bolt.agent.tool.awaitAgent', icon: 'lucide:hourglass' },
	dequeue_agent_message: {
		labelKey: 'bolt.agent.tool.dequeueAgentMessage',
		icon: 'lucide:list-x'
	},
	reorder_agent_queue: {
		labelKey: 'bolt.agent.tool.reorderAgentQueue',
		icon: 'lucide:list-ordered'
	},
	interrupt_agent: { labelKey: 'bolt.agent.tool.interruptAgent', icon: 'lucide:octagon-x' },
	stop_agent: { labelKey: 'bolt.agent.tool.stopAgent', icon: 'lucide:pause' },
	resume_agent: { labelKey: 'bolt.agent.tool.resumeAgent', icon: 'lucide:play' }
};

/**
 * Arguments worth putting on the collapsed row, most identifying first.
 *
 * A generic scan of the input would surface `limit` as readily as `collection`, and `collection` is
 * the one field that tells two reads apart.
 */
const DETAIL_KEYS = [
	'agentId',
	'collection',
	'task',
	'action',
	'path',
	'filePath',
	'query',
	'name'
] as const;

const SANDBOX_AGENT_TOOLS = new Set([
	'spawn_agent',
	'list_agents',
	'read_agent',
	'message_agent',
	'await_agent',
	'dequeue_agent_message',
	'reorder_agent_queue',
	'interrupt_agent',
	'stop_agent',
	'resume_agent'
]);

/**
 * The conversation as the panel shows it.
 *
 * Projected over the whole transcript rather than row by row: a call and its result are separate
 * rows joined by `toolCallId`, and a call cannot show what it returned without reading past itself.
 */
export function toPanelMessages(
	records: readonly Readonly<Record<string, unknown>>[],
	turns: readonly Readonly<Record<string, unknown>>[] = []
): readonly PanelMessage[] {
	// An answer is a part of the same turn as the call it answers, joined by the id the loop assigned.
	// It is read across the whole transcript first because a call cannot show what it returned without
	// reading past itself.
	const results = new Map<string, unknown>();
	for (const record of records) {
		for (const part of partsOf(record)) {
			if (part.kind !== 'tool-result' || typeof part.id !== 'string') continue;
			results.set(part.id, part.output);
		}
	}

	const turnStatus = new Map<string, string>();
	const subagentTurnIds = new Set<string>();
	for (const turn of turns) {
		const turnId = turn.id;
		if (typeof turnId === 'string' && typeof turn.status === 'string') {
			turnStatus.set(turnId, turn.status);
		}
		const subagentId = turn.parent_agent_id;
		if (typeof turnId !== 'string' || typeof subagentId !== 'string') continue;
		subagentTurnIds.add(turnId);
	}
	const byAgent = new Map<string, Readonly<Record<string, unknown>>[]>();
	for (const record of records) {
		const turnId = record.turn_id;
		if (typeof turnId !== 'string' || !subagentTurnIds.has(turnId)) continue;
		const agentId = record.conversation_id;
		if (typeof agentId !== 'string') continue;
		const bucket = byAgent.get(agentId) ?? [];
		bucket.push(record);
		byAgent.set(agentId, bucket);
	}

	const context: ProjectionContext = { results, byAgent, turnStatus };
	// A child agent's rows belong beneath its spawn call, not in the root conversation flow.
	const roots = records.filter((record) => {
		const turnId = record.turn_id;
		return typeof turnId !== 'string' || !subagentTurnIds.has(turnId);
	});

	// A checkpoint absorbs everything before it. Later checkpoints therefore contain earlier ones,
	// which is what makes repeated compaction readable rather than a chain of recaps of recaps.
	let output: PanelMessage[] = [];
	for (const record of roots) {
		const projected = projectRoot(record, context);
		if (projected.checkpoint !== undefined) {
			output = [{ ...projected.checkpoint, before: output }];
		} else {
			output.push(...projected.rows);
		}
	}
	return output;
}

type RootProjection = Readonly<{
	/** A fold replaces everything the transcript has projected so far. */
	readonly checkpoint?: PanelCheckpoint;
	readonly rows: readonly PanelMessage[];
}>;

/**
 * Projects one root record: a summary or a goal folds the whole prefix, a relayed agent message is a
 * row of its own, and everything else is read by the per-record projector. Split out of the framing
 * loop so the fold policy and the row projection do not nest four decisions deep in one place.
 */
function projectRoot(
	record: Readonly<Record<string, unknown>>,
	context: ProjectionContext
): RootProjection {
	if (record.kind === 'usage') return { rows: [] };
	if (record.kind === 'summary') {
		const checkpoint = checkpointFold(record);
		return checkpoint === null
			? { rows: toPanelRow(record, context, 0) }
			: { checkpoint, rows: [] };
	}
	if (record.kind === 'agent_message') {
		const relayed = toInboundAgentMessage(record);
		return relayed === null ? { rows: toPanelRow(record, context, 0) } : { rows: [relayed] };
	}
	if (record.kind === 'goal') {
		const verdict = goalVerdict(record);
		return verdict === null ? { rows: toPanelRow(record, context, 0) } : { rows: [verdict] };
	}
	return { rows: toPanelRow(record, context, 0) };
}

/** The checkpoint this summary record folds, or nothing when it is malformed. */
function checkpointFold(record: Readonly<Record<string, unknown>>): PanelCheckpoint | null {
	const id = record.id;
	const content = textOf(record);
	// A malformed checkpoint — no id, or no text to fold — is a row like any other.
	if (typeof id !== 'string' || content === null) return null;
	const parsed = parseStoredSummary(content);
	return { kind: 'checkpoint', key: id, summary: parsed.text, before: [], fold: parsed.fold };
}

/** The verifier verdict or scheduled prompt this goal record folds, or nothing when it reads as content. */
function goalVerdict(record: Readonly<Record<string, unknown>>): PanelGoal | PanelVerifier | null {
	const id = record.id;
	const content = textOf(record);
	// A malformed goal is a row like any other too — a verifier verdict missing its text reads
	// as plain content rather than vanishing.
	if (typeof id !== 'string' || content === null) return null;
	const scheduled = parseStoredVerifierScheduled(content);
	if (scheduled) return { kind: 'verifier', key: id, prompt: scheduled };
	const verdict = parseStoredGoalVerdict(content);
	if (verdict === null) return null;
	return {
		kind: 'goal',
		key: id,
		achieved: verdict.achieved,
		summary: verdict.summary,
		gaps: verdict.gaps
	};
}

type ProjectionContext = {
	readonly results: ReadonlyMap<string, unknown>;
	readonly byAgent: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>;
	readonly turnStatus: ReadonlyMap<string, string>;
};

/**
 * How far a delegated transcript may nest before the panel stops descending.
 *
 * Recursive children are supported. The guard bounds presentation work and protects the browser
 * from malformed cyclic lineage; the runtime owns the independent delegation budget.
 */
const MAX_SUBAGENT_DEPTH = 3;

/**
 * Read one record as the ordered steps it is made of.
 *
 * A turn is one message and its steps are parts inside it, so a record is projected by walking its
 * parts rather than by reading one of them. The row used to hold a single part and a turn was spread
 * over several rows, which is why one turn rendered as several separate agent blocks.
 */
function toPanelRow(
	record: Readonly<Record<string, unknown>>,
	context: ProjectionContext,
	depth: number
): PanelMessage[] {
	const id = record.id;
	if (typeof id !== 'string') return [];
	if (record.kind === 'usage') return [];
	const role = typeof record.role === 'string' ? record.role : 'assistant';
	if (record.kind === 'reasoning') {
		const content = textOf(record);
		return content !== null && content.trim() ? [{ kind: 'reasoning', key: id, content }] : [];
	}
	const rows: PanelMessage[] = [];
	for (const [index, part] of partsOf(record).entries()) {
		const key = `${id}:${index}`;
		if (part.kind === 'tool') {
			const call = toToolCall(part, key, context, depth);
			rows.push(toOutboundAgentMessage(part, call, context) ?? call);
			continue;
		}
		// An answer is not dropped — it is shown on the call it answers, which names the arguments that
		// produced it. On its own it is an unattributed blob of JSON.
		if (part.kind === 'tool-result') continue;
		const text = typeof part.text === 'string' ? part.text : '';
		// A turn that only called a tool has no words of its own. The calls already say what it did, so a
		// blank bubble beside them is noise.
		if (text.trim().length === 0) continue;
		rows.push({ kind: 'text', key, role, content: text });
	}
	// A record that produced nothing still happened. Rendering it empty beats dropping a turn out of
	// the conversation, which is what silently losing a failed turn would look like.
	return rows.length > 0 ? rows : [{ kind: 'text', key: id, role, content: '' }];
}

/** Projects one stored tool call into the collapsed row the panel renders. */
function toToolCall(
	call: unknown,
	key: string,
	context: ProjectionContext,
	depth: number
): PanelToolCall {
	const record = Option.getOrElse(decodeJsonObject(call), emptyJsonObject);
	const name = typeof record.name === 'string' ? record.name : 'tool';
	const metadata = TOOL_METADATA[name];
	const mcpParsed = parsePublicMcpToolName(name);
	const input = Option.getOrUndefined(decodeJsonObject(record.input));
	const id = typeof record.id === 'string' ? record.id : null;
	const answered = id !== null && context.results.has(id);
	const output = answered ? context.results.get(id) : undefined;
	const decodedOutput = Option.getOrElse(decodeJsonObject(output), emptyJsonObject);
	const childAgentId =
		name === 'spawn_agent' && typeof decodedOutput.agentId === 'string'
			? decodedOutput.agentId
			: undefined;
	const children =
		childAgentId !== undefined && depth < MAX_SUBAGENT_DEPTH
			? (context.byAgent.get(childAgentId) ?? []).flatMap((row) =>
					toPanelRow(row, context, depth + 1)
				)
			: [];
	// The loop turns a thrown tool into `{ error }` and feeds it back to the model rather than failing
	// the turn, so a failed call is visible only here — the run around it still reports success.
	const error = typeof decodedOutput.error === 'string' ? decodedOutput.error : null;
	const labelKey = mcpParsed ? null : (metadata?.labelKey ?? null);
	const label = mcpParsed
		? `${humanize(mcpParsed.server)} · ${humanize(mcpParsed.tool)}`
		: metadata
			? null
			: humanize(name);
	const icon = mcpParsed
		? 'lucide:plug'
		: SANDBOX_AGENT_TOOLS.has(name)
			? (metadata?.icon ?? 'lucide:users')
			: (metadata?.icon ?? 'lucide:wrench');
	const family = mcpParsed ? 'mcp' : SANDBOX_AGENT_TOOLS.has(name) ? 'sandbox' : null;
	const requests =
		answered &&
		decodedOutput.resultType === 'input_required' &&
		Array.isArray(decodedOutput.requests)
			? decodedOutput.requests
			: null;
	const elicitation = requests
		? requests.flatMap((request) =>
				Option.match(decodeElicitationRequest(request), {
					onNone: () => [],
					onSome: (decoded) => [
						{
							id: decoded.id ?? `elicitation-${decoded.message}`,
							message: decoded.message,
							...(decoded.mode === undefined ? {} : { mode: decoded.mode }),
							...(decoded.url === undefined ? {} : { url: decoded.url })
						}
					]
				})
			)
		: null;
	const inputRequired = requests !== null;
	const state: PanelToolCall['state'] = inputRequired
		? 'needs_input'
		: answered
			? error === null
				? 'complete'
				: 'failed'
			: 'running';
	let detail: string | null = null;
	if (input) {
		for (const field of DETAIL_KEYS) {
			const value = input[field];
			if (typeof value === 'string' && value.trim().length > 0) {
				detail = clamp(value.trim(), 64);
				break;
			}
		}
	}
	return {
		kind: 'tool',
		key,
		name,
		labelKey,
		label,
		icon,
		detail,
		input: input && Object.keys(input).length > 0 ? formatPayload(input) : null,
		output: answered && error === null ? formatPayload(output) : null,
		error: error === null ? null : clamp(error),
		state,
		elicitation,
		family,
		children
	};
}

/** Reads a stored inbound message, or nothing when the record is marked as one but carries no text. */
function toInboundAgentMessage(
	record: Readonly<Record<string, unknown>>
): PanelAgentMessage | null {
	const id = record.id;
	const text = textOf(record);
	if (typeof id !== 'string' || text === null) return null;
	const from = Option.getOrElse(decodeJsonObject(record.from), emptyJsonObject);
	return {
		kind: 'agent-message',
		key: id,
		direction: 'in',
		agentName: typeof from.agentName === 'string' ? from.agentName : null,
		sessionTitle: typeof from.title === 'string' ? from.title : null,
		agentId: typeof from.agentId === 'string' ? from.agentId : null,
		content: text,
		state: 'complete',
		error: null
	};
}

/**
 * The message a `message_agent` call carried, or nothing when the call is some other tool.
 *
 * Takes the delivery state and the failure text from the projected call, so a message reports what it
 * did exactly as every other call does, and the message body and the recipient from the stored part,
 * which is not capped the way the disclosure payloads are. The recipient's name comes back in the
 * tool's own answer; before that lands there is only the session id the sender addressed.
 */
function toOutboundAgentMessage(
	part: Readonly<Record<string, unknown>>,
	call: PanelToolCall,
	context: ProjectionContext
): PanelAgentMessage | null {
	if (call.name !== 'message_agent') return null;
	const input = Option.getOrElse(decodeJsonObject(part.input), emptyJsonObject);
	if (typeof input.message !== 'string') return null;
	const id = typeof part.id === 'string' ? part.id : null;
	const answer = id === null ? undefined : context.results.get(id);
	const output = Option.getOrElse(decodeJsonObject(answer), emptyJsonObject);
	return {
		kind: 'agent-message',
		key: call.key,
		direction: 'out',
		agentName: typeof output.agentName === 'string' ? output.agentName : null,
		sessionTitle: typeof output.title === 'string' ? output.title : null,
		agentId: typeof input.agentId === 'string' ? input.agentId : null,
		content: input.message,
		state: call.state === 'needs_input' ? 'running' : call.state,
		error: call.error
	};
}

/** Caps a tool payload so an expanded call stays readable in the panel scroller. */
function formatPayload(value: unknown): string {
	return Effect.runSync(
		Effect.try(() => clamp(JSON.stringify(value, null, 2) ?? String(value))).pipe(
			Effect.catch(() => Effect.succeed(clamp(String(value))))
		)
	);
}

/** Truncates a payload or detail string at the panel's display cap. */
function clamp(text: string, limit: number = PAYLOAD_LIMIT): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * The ordered steps a record is made of.
 *
 * Every record carries `parts`, including a person's message — a user turn is one thing they said,
 * which is one part. Keeping the shape uniform is what lets one projector read the whole transcript.
 */
function partsOf(record: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
	return Option.getOrElse(decodeJsonObjects(record.parts), () => []);
}

/** The record's own words: the first text part, or nothing when it never produced any. */
function textOf(record: Readonly<Record<string, unknown>>): string | null {
	for (const part of partsOf(record)) {
		if (part.kind === 'text' && typeof part.text === 'string') return part.text;
	}
	return null;
}

/**
 * What this conversation has cost so far, as the provider reported it.
 *
 * Every number here is read from embedded message usage, which the loop writes verbatim from the
 * provider's own accounting. Nothing is derived: no token estimate, and above all no cost computed
 * from a price list, because a figure a reader takes for a bill has to be the bill.
 */
/** First finite number among the provider's spelling variants for one usage field. */
function readNumber(
	source: Readonly<Record<string, unknown>>,
	keys: readonly string[]
): number | null {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === 'number' && Number.isFinite(value)) return value;
	}
	return null;
}

/** Sums embedded message usage into the occupancy and spend the panel can show. */
export function toPanelUsage(
	records: readonly Readonly<Record<string, unknown>>[],
	contextLength: number | null = null
) {
	let contextTokens: number | null = null;
	let totalTokens = 0;
	let costUsd: number | null = null;
	for (const record of records) {
		const usage = Option.getOrUndefined(decodeJsonObject(record.usage));
		if (usage === undefined) continue;
		// A delegated agent runs against a window of its own. Counting its usage here would report the
		// person's next prompt as landing in whatever context a subagent happened to leave behind.
		if (record.delegated === true) continue;
		// The newest request's input is the live window occupancy; earlier ones describe windows that
		// have already been replaced.
		const input = readNumber(usage, [
			'inputTokens',
			'input_tokens',
			'promptTokens',
			'prompt_tokens'
		]);
		if (input !== null) contextTokens = input;
		const total =
			readNumber(usage, ['totalTokens', 'total_tokens', 'total']) ??
			(input ?? 0) +
				(readNumber(usage, [
					'outputTokens',
					'output_tokens',
					'completionTokens',
					'completion_tokens'
				]) ?? 0);
		totalTokens += total;
		const cost = readNumber(usage, ['costUsd', 'cost', 'total_cost', 'totalCost']);
		if (cost !== null) costUsd = (costUsd ?? 0) + cost;
	}
	return { contextTokens, contextLength, totalTokens, costUsd };
}
type PanelUsage = ReturnType<typeof toPanelUsage>;

/**
 * The conversation's durable totals, as the session row carries them.
 *
 * Read rather than summed. The loop accumulates these onto `chat_session` as each turn settles, so
 * they survive the deletion of the messages that produced them — which is the whole point of storing
 * them at all.
 */
/** Reads the session row's durable usage counters, or null when nothing has settled. */
type DurableSessionTotals = Readonly<{
	readonly usage_cost_usd: number;
	readonly usage_cost_micro_units: number;
	readonly usage_cost_currency: string | null;
	readonly usage_total_tokens: number;
	readonly usage_turns_counted: number;
	readonly usage_turns_unreported: number;
}>;

export function toSessionTotals(record: DurableSessionTotals | undefined) {
	if (!record) return null;
	const totals = {
		costUsd: record.usage_cost_usd,
		/**
		 * What the host will invoice, in millionths of `currency`, and the currency it is in.
		 *
		 * Preferred over `costUsd` wherever both exist, because they are not the same fact: the
		 * provider charge is what the model cost, and this is what the person reading it will pay.
		 * `null` currency means the host prices nothing and the provider figure is all there is.
		 */
		costMicroUnits: record.usage_cost_micro_units,
		currency: record.usage_cost_currency,
		totalTokens: record.usage_total_tokens,
		turnsCounted: record.usage_turns_counted,
		turnsUnreported: record.usage_turns_unreported
	};
	// A session that has settled nothing has nothing to say, which is not the same as zero spend.
	return totals.turnsCounted === 0 ? null : totals;
}
type SessionTotals = NonNullable<ReturnType<typeof toSessionTotals>>;

/**
 * What this conversation has cost, as one string, or nothing when no figure has been reported.
 *
 * The host's own charge wins over the provider's whenever there is one. They are different numbers
 * on any host that bills in its own currency, and the one worth putting beside a conversation is the
 * one its owner is invoiced — a provider figure in that position reads as the bill and is not it. A
 * host that prices nothing leaves the provider charge as the only honest answer, so that is shown.
 *
 * `≥` marks a total that is a floor: some turn's host reported no cost for it, and a conversation
 * nobody could price must not read as a cheap one.
 */
export function formatSessionCost(totals: SessionTotals | null): string | null {
	if (totals === null) return null;
	const priced = totals.currency !== null && totals.costMicroUnits > 0;
	if (!priced && totals.costUsd === 0 && totals.turnsUnreported >= totals.turnsCounted) return null;
	const floor = totals.turnsUnreported > 0 ? '≥' : '';
	return priced
		? `${floor}${totals.currency} ${(totals.costMicroUnits / 1_000_000).toFixed(4)}`
		: `${floor}$${totals.costUsd.toFixed(4)}`;
}

/** Walks checkpoint history to see whether the pending echo has already landed. */
function containsPrompt(messages: readonly PanelMessage[], pending: string): boolean {
	return messages.some(
		(message) =>
			(message.kind === 'text' && message.role === 'user' && message.content === pending) ||
			(message.kind === 'checkpoint' && containsPrompt(message.before, pending))
	);
}

/**
 * The conversation as the panel shows it, including a prompt that has not landed yet.
 *
 * Admission atomically writes the user's message and queued turn, then returns before inference.
 * The echo covers only the transport-to-replica gap and disappears the moment the real row arrives,
 * without a timer or a second response channel.
 * Sending the same text twice suppresses the echo one message early, which is invisible.
 */
export function withPendingEcho(
	messages: readonly PanelMessage[],
	pending: string | null
): readonly PanelMessage[] {
	if (pending === null) return messages;
	// A prompt that landed before a checkpoint is inside its `before`, and an echo alongside it would
	// be a duplicate of a message the reader can already see — which is what `containsPrompt` walks.
	if (containsPrompt(messages, pending)) return messages;
	return [...messages, { kind: 'text', key: 'pending', role: 'user', content: pending }];
}
