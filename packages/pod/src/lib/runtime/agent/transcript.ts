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
};

export type PanelMessage = PanelText | PanelToolCall;

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
	records: readonly Readonly<Record<string, unknown>>[]
): readonly PanelMessage[] {
	const results = new Map<string, unknown>();
	for (const record of records) {
		const stored = storedMessage(record);
		if (!stored || stored.role !== 'tool') continue;
		const callId = stored.message.toolCallId;
		if (typeof callId === 'string') results.set(callId, parsedContent(stored.message.content));
	}
	return records.flatMap((record) => toPanelRow(record, results));
}

/**
 * Read one replica row, or nothing.
 *
 * `parts` holds exactly one message; a row without one is a row this panel cannot render, and
 * dropping it beats printing `undefined` into a conversation.
 */
function toPanelRow(
	record: Readonly<Record<string, unknown>>,
	results: ReadonlyMap<string, unknown>
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
		toToolCall(call, `${id}:${index}`, results)
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
	results: ReadonlyMap<string, unknown>
): PanelToolCall {
	const record = isRecord(call) ? call : {};
	const name = typeof record.name === 'string' ? record.name : 'tool';
	const metadata = TOOL_METADATA[name] ?? { label: humanize(name), icon: 'lucide:wrench' };
	const input = isRecord(record.input) ? record.input : undefined;
	const id = typeof record.id === 'string' ? record.id : null;
	const answered = id !== null && results.has(id);
	const output = answered ? results.get(id) : undefined;
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
		state: answered ? (error === null ? 'complete' : 'failed') : 'running'
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
export function withPendingEcho(
	messages: readonly PanelMessage[],
	pending: string | null
): readonly PanelMessage[] {
	if (pending === null) return messages;
	const landed = messages.some(
		(message) => message.kind === 'text' && message.role === 'user' && message.content === pending
	);
	if (landed) return messages;
	return [...messages, { kind: 'text', key: 'pending', role: 'user', content: pending }];
}
