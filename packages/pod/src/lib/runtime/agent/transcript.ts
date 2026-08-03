/**
 * How a stored `chat_message` row reads in the panel.
 *
 * The loop stores one `AiMessage` verbatim per row, so this is a projection of the stored message
 * and not a second model of the conversation. Kept out of the component because it is the only part
 * with an answer worth checking, and this package has no browser runner to check it through one.
 */
export type PanelText = {
	readonly kind: 'text';
	readonly key: string;
	readonly role: string;
	readonly content: string;
	readonly status?: string;
};

/**
 * One call the agent made, with the answer it got back.
 *
 * A turn can call the same tool twice; the loop writes both into one assistant row and each answer
 * into a row of its own. Naming them in a joined string ("read_collection, read_collection") loses
 * which arguments produced which rows, so a call is the unit here rather than the row that carried
 * it.
 */
export type PanelToolCall = {
	readonly kind: 'tool';
	readonly key: string;
	/** Registered name, kept verbatim — tenant and host tools are not in the label table. */
	readonly name: string;
	readonly label: string;
	readonly icon: string;
	/** The one argument worth reading at a glance, so two calls to one tool differ on sight. */
	readonly detail: string | null;
	readonly input: string | null;
	readonly output: string | null;
	readonly error: string | null;
	readonly state: 'running' | 'complete' | 'failed';
	/**
	 * The delegated agent's own transcript, projected the same way this one was.
	 *
	 * Empty for every tool but `spawn_subagent`. A subagent writes into its parent's session with a
	 * turn of its own, so without this its messages interleave into the parent by `seq` and its task
	 * prompt reads as something the person typed.
	 */
	readonly children: readonly PanelMessage[];
};

/**
 * A point where the conversation was replaced, for the model, by a summary of itself.
 *
 * Rendered rather than hidden because the alternative is history that vanishes with no mark. `before`
 * is the whole prefix, not the slice since the previous checkpoint: nothing was deleted, so showing
 * all of it costs nothing, and a summary of a summary with no path back to the original is the
 * failure this exists to prevent.
 */
export type PanelCheckpoint = {
	readonly kind: 'checkpoint';
	readonly key: string;
	readonly summary: string;
	readonly before: readonly PanelMessage[];
};

export type PanelMessage = PanelText | PanelToolCall | PanelCheckpoint;

/**
 * Tool payloads are held behind a disclosure and capped.
 *
 * `read_collection` answers with every policy-visible row it was asked for. That is the reader's own
 * tenant data rather than a leak, but pasting a hundred records into a conversation buries the
 * conversation, and the panel scroller has to lay all of it out. Capping the text keeps an expanded
 * call readable and bounds what one row can cost.
 */
const PAYLOAD_LIMIT = 2_000;

type ToolMetadata = { readonly label: string; readonly icon: string };

/** The tools this package resolves itself. Tenant and host tools are named by their registration. */
const TOOL_METADATA: Readonly<Record<string, ToolMetadata>> = {
	describe_workspace: { label: 'Describe workspace', icon: 'lucide:book-open' },
	read_collection: { label: 'Read collection', icon: 'lucide:table' },
	write_collection: { label: 'Write collection', icon: 'lucide:database' },
	spawn_subagent: { label: 'Delegate task', icon: 'lucide:network' }
};

/**
 * Arguments worth putting on the collapsed row, most identifying first.
 *
 * A generic scan of the input would surface `limit` as readily as `collection`, and `collection` is
 * the one field that tells two reads apart.
 */
const DETAIL_KEYS = ['collection', 'task', 'action', 'path', 'filePath', 'query', 'name'] as const;

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
	const results = new Map<string, unknown>();
	for (const record of records) {
		const stored = storedMessage(record);
		if (!stored || stored.role !== 'tool') continue;
		const callId = stored.message.toolCallId;
		if (typeof callId === 'string') results.set(callId, parsedContent(stored.message.content));
	}

	// `runSubagent` tags the child's turn `subagent:<spawn call id>`, so the call that started a
	// delegated agent names the turn that carries its transcript. That is the whole join.
	const turnByCallId = new Map<string, string>();
	const subagentTurnIds = new Set<string>();
	for (const turn of turns) {
		const turnId = turn.norbital_id;
		const subagentId = turn.subagent_id;
		if (typeof turnId !== 'string' || typeof subagentId !== 'string') continue;
		subagentTurnIds.add(turnId);
		if (subagentId.startsWith('subagent:')) {
			turnByCallId.set(subagentId.slice('subagent:'.length), turnId);
		}
	}
	const byTurn = new Map<string, Readonly<Record<string, unknown>>[]>();
	for (const record of records) {
		const turnId = record.turn_id;
		if (typeof turnId !== 'string' || !subagentTurnIds.has(turnId)) continue;
		const bucket = byTurn.get(turnId) ?? [];
		bucket.push(record);
		byTurn.set(turnId, bucket);
	}

	const context: ProjectionContext = { results, turnByCallId, byTurn };
	// A subagent's rows belong to its call, not to the conversation they share a session with.
	const roots = records.filter((record) => {
		const turnId = record.turn_id;
		return typeof turnId !== 'string' || !subagentTurnIds.has(turnId);
	});

	// A checkpoint absorbs everything before it. Later checkpoints therefore contain earlier ones,
	// which is what makes repeated compaction readable rather than a chain of recaps of recaps.
	let output: PanelMessage[] = [];
	for (const record of roots) {
		if (record.kind === 'summary') {
			const stored = storedMessage(record);
			const id = record.norbital_id;
			const content = stored?.message.content;
			if (typeof id === 'string' && typeof content === 'string') {
				output = [{ kind: 'checkpoint', key: id, summary: content, before: output }];
				continue;
			}
		}
		output.push(...toPanelRow(record, context, 0));
	}
	return output;
}

type ProjectionContext = {
	readonly results: ReadonlyMap<string, unknown>;
	readonly turnByCallId: ReadonlyMap<string, string>;
	readonly byTurn: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>;
};

/**
 * How far a delegated transcript may nest before the panel stops descending.
 *
 * The loop already refuses a subagent that spawns another, so two is the real ceiling. The guard is
 * against a cycle in the data — a turn that somehow names itself would otherwise recurse forever in
 * the reader's browser rather than failing where it was written.
 */
const MAX_SUBAGENT_DEPTH = 3;

/**
 * Read one replica row, or nothing.
 *
 * `parts` holds exactly one message; a row without one is a row this panel cannot render, and
 * dropping it beats printing `undefined` into a conversation.
 */
function toPanelRow(
	record: Readonly<Record<string, unknown>>,
	context: ProjectionContext,
	depth: number
): PanelMessage[] {
	const id = record.norbital_id;
	const stored = storedMessage(record);
	if (typeof id !== 'string' || !stored) return [];
	// A tool result is not dropped — it is shown on the call it answers, which names the arguments
	// that produced it. On its own it is an unattributed blob of JSON.
	if (stored.role === 'tool') return [];

	const raw = stored.message.toolCalls;
	const calls: readonly unknown[] = Array.isArray(raw) ? raw : [];
	const rows: PanelMessage[] = calls.map((call, index) =>
		toToolCall(call, `${id}:${index}`, context, depth)
	);

	const body = stored.message.content;
	const content = typeof body === 'string' ? body : '';
	// An assistant turn that only called a tool has empty content by construction. The calls above
	// already say what it did, so a blank bubble beside them is noise.
	if (content.trim().length === 0 && rows.length > 0) return rows;
	return [
		{
			kind: 'text',
			key: id,
			role: stored.role,
			content,
			...(typeof record.status === 'string' ? { status: record.status } : {})
		},
		...rows
	];
}

function toToolCall(
	call: unknown,
	key: string,
	context: ProjectionContext,
	depth: number
): PanelToolCall {
	const record = isRecord(call) ? call : {};
	const name = typeof record.name === 'string' ? record.name : 'tool';
	const metadata = TOOL_METADATA[name] ?? { label: humanize(name), icon: 'lucide:wrench' };
	const input = isRecord(record.input) ? record.input : undefined;
	const id = typeof record.id === 'string' ? record.id : null;
	const answered = id !== null && context.results.has(id);
	const output = answered ? context.results.get(id) : undefined;
	const childTurn = id === null ? undefined : context.turnByCallId.get(id);
	const children =
		childTurn !== undefined && depth < MAX_SUBAGENT_DEPTH
			? (context.byTurn.get(childTurn) ?? []).flatMap((row) => toPanelRow(row, context, depth + 1))
			: [];
	// The loop turns a thrown tool into `{ error }` and feeds it back to the model rather than failing
	// the turn, so a failed call is visible only here — the run around it still reports success.
	const error = isRecord(output) && typeof output.error === 'string' ? output.error : null;
	return {
		kind: 'tool',
		key,
		name,
		label: metadata.label,
		icon: metadata.icon,
		detail: toDetail(input),
		input: input && Object.keys(input).length > 0 ? formatPayload(input) : null,
		output: answered && error === null ? formatPayload(output) : null,
		error: error === null ? null : clamp(error),
		state: answered ? (error === null ? 'complete' : 'failed') : 'running',
		children
	};
}

function toDetail(input: Readonly<Record<string, unknown>> | undefined): string | null {
	if (!input) return null;
	for (const key of DETAIL_KEYS) {
		const value = input[key];
		if (typeof value === 'string' && value.trim().length > 0) return clamp(value.trim(), 64);
	}
	return null;
}

function formatPayload(value: unknown): string {
	try {
		return clamp(JSON.stringify(value, null, 2) ?? String(value));
	} catch {
		return clamp(String(value));
	}
}

function clamp(text: string, limit: number = PAYLOAD_LIMIT): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** `read_collection` reads as `Read collection`, matching how the built-ins are labelled. */
function humanize(name: string): string {
	const words = name.split(/[_-]+/).filter(Boolean);
	const first = words[0];
	if (first === undefined) return name;
	return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/** A `parts[0]` entry that at least names its role — every other field stays unknown until read. */
type StoredMessage = {
	readonly role: string;
	readonly message: Readonly<Record<string, unknown>>;
};

function storedMessage(record: Readonly<Record<string, unknown>>): StoredMessage | null {
	const parts = record.parts;
	if (!Array.isArray(parts)) return null;
	const message: unknown = parts[0];
	if (!isRecord(message)) return null;
	const role = message.role;
	return typeof role === 'string' ? { role, message } : null;
}

function parsedContent(content: unknown): unknown {
	if (typeof content !== 'string') return content;
	try {
		return JSON.parse(content) as unknown;
	} catch {
		return content;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The conversation as the panel shows it, including a prompt that has not landed yet.
 *
 * A round trip runs the whole agent loop, and the loop writes the user's message before it starts
 * thinking — so the echo exists only to cover the gap before the replica has it, and disappears the
 * moment the real row arrives rather than being cleared on a timer or by the response returning.
 * Sending the same text twice suppresses the echo one message early, which is invisible.
 */
/**
 * What this conversation has cost so far, as the provider reported it.
 *
 * Every number here is read from `chat_message.usage`, which the loop writes verbatim from the
 * provider's own accounting. Nothing is derived: no token estimate, and above all no cost computed
 * from a price list, because a figure a reader takes for a bill has to be the bill.
 */
export type PanelUsage = {
	/** Tokens in the most recent request — how full the window actually was. */
	readonly contextTokens: number | null;
	/** The window those tokens sat in, when the host published one for the model. */
	readonly contextLength: number | null;
	readonly totalTokens: number;
	/** Only when the host passed a cost through. `null` means unreported, never zero. */
	readonly costUsd: number | null;
};

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

export function toPanelUsage(
	records: readonly Readonly<Record<string, unknown>>[],
	contextLength: number | null = null
): PanelUsage {
	let contextTokens: number | null = null;
	let totalTokens = 0;
	let costUsd: number | null = null;
	for (const record of records) {
		const usage = record.usage;
		if (!isRecord(usage)) continue;
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
		const cost = readNumber(usage, ['cost', 'total_cost', 'totalCost']);
		if (cost !== null) costUsd = (costUsd ?? 0) + cost;
	}
	return { contextTokens, contextLength, totalTokens, costUsd };
}

function containsPrompt(messages: readonly PanelMessage[], pending: string): boolean {
	return messages.some(
		(message) =>
			(message.kind === 'text' && message.role === 'user' && message.content === pending) ||
			(message.kind === 'checkpoint' && containsPrompt(message.before, pending))
	);
}

export function withPendingEcho(
	messages: readonly PanelMessage[],
	pending: string | null
): readonly PanelMessage[] {
	if (pending === null) return messages;
	// Only the visible tail is searched. A prompt that landed before a checkpoint is inside its
	// `before`, and an echo alongside it would be a duplicate of a message the reader can already see.
	const landed = messages.some(
		(message) =>
			(message.kind === 'text' && message.role === 'user' && message.content === pending) ||
			(message.kind === 'checkpoint' && containsPrompt(message.before, pending))
	);
	if (landed) return messages;
	return [...messages, { kind: 'text', key: 'pending', role: 'user', content: pending }];
}
