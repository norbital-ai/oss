/**
 * How a stored `chat_message` row reads in the panel.
 *
 * The loop stores one `AiMessage` verbatim per row, so this is a projection of the stored message
 * and not a second model of the conversation. Kept out of the component because it is the only part
 * with an answer worth checking, and this package has no browser runner to check it through one.
 */
export type PanelMessage = {
	readonly key: string;
	readonly role: string;
	readonly content: string;
	readonly status?: string;
};

/**
 * Read one replica row, or nothing.
 *
 * `parts` holds exactly one message; a row without one is a row this panel cannot render, and
 * dropping it beats printing `undefined` into a conversation.
 */
export function toPanelMessage(record: Readonly<Record<string, unknown>>): PanelMessage[] {
	const id = record.norbital_id;
	const parts = record.parts;
	if (typeof id !== 'string' || !Array.isArray(parts)) return [];
	const message = parts[0] as Record<string, unknown> | undefined;
	if (!message || typeof message.role !== 'string') return [];
	// Tool results are machine context. The assistant call immediately before them already names the
	// action; printing the raw JSON result turns a conversation into a debug console.
	if (message.role === 'tool') return [];
	return [
		{
			key: id,
			role: message.role,
			content: describeMessage(message),
			...(typeof record.status === 'string' ? { status: record.status } : {})
		}
	];
}

/**
 * What an assistant turn that only called a tool has to say.
 *
 * Its `content` is empty by construction — the model chose a tool instead of prose — so rendering it
 * raw leaves a blank bubble where the conversation visibly did something. Naming the call is what
 * the transcript actually contains.
 */
function describeMessage(message: Readonly<Record<string, unknown>>): string {
	const content = typeof message.content === 'string' ? message.content : '';
	if (content.trim().length > 0) return content;
	const calls = message.toolCalls;
	if (!Array.isArray(calls) || calls.length === 0) return content;
	const names = calls.flatMap((call) => {
		const name = (call as Record<string, unknown>)?.name;
		return typeof name === 'string' ? [name] : [];
	});
	return names.length > 0 ? `Using ${names.join(', ')}…` : content;
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
	const landed = messages.some((message) => message.role === 'user' && message.content === pending);
	return landed ? messages : [...messages, { key: 'pending', role: 'user', content: pending }];
}
