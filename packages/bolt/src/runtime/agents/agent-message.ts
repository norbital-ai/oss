/**
 * What one agent says to another, as the receiving conversation stores it.
 *
 * `message_sandbox_agent` writes into a sibling session's log, and the only role that log accepts for
 * something the agent did not itself produce is `user`. Stored as bare text that is exactly what it
 * became: a message the reader sees attributed to themselves, in their own bubble, in a conversation
 * they were not part of. The sender travels with the message so the panel can say who spoke, and so
 * the receiving agent's prompt says it too rather than presenting another agent's words as the
 * person's own instruction.
 *
 * Deliberately dependency-free: the runtime writes this shape and the browser panel reads it, and a
 * second, quietly diverging notion of "who sent this" is the failure worth spending a shared module
 * to avoid.
 */

export const AGENT_MESSAGE_KIND = 'agent_message';

/** The session a message came from, as much of it as the sender could name. */
export type AgentMessageSender = {
	readonly sessionId: string;
	readonly agentName: string;
	/** The conversation's own title, which is what tells two sessions of one agent apart. */
	readonly title: string | null;
};

export type StoredAgentMessage = {
	readonly kind: typeof AGENT_MESSAGE_KIND;
	readonly from: AgentMessageSender;
	readonly text: string;
};

export const encodeAgentMessage = (from: AgentMessageSender, text: string): StoredAgentMessage => ({
	kind: AGENT_MESSAGE_KIND,
	from,
	text
});

/** A plain object, as opposed to an array or a primitive whose fields cannot be read. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a stored record as an agent-to-agent message, or nothing when it is an ordinary one.
 *
 * Accepts the JSON string form as well as the decoded object: the log column is `jsonb`, and the
 * paths that reach this have handed it back both ways.
 */
export function parseAgentMessage(content: unknown): StoredAgentMessage | null {
	if (typeof content === 'string') {
		try {
			return parseAgentMessage(JSON.parse(content));
		} catch {
			return null;
		}
	}
	if (!isRecord(content) || content.kind !== AGENT_MESSAGE_KIND) return null;
	const text = content.text;
	const from = content.from;
	if (typeof text !== 'string' || !isRecord(from)) return null;
	const sessionId = from.sessionId;
	const agentName = from.agentName;
	if (typeof sessionId !== 'string' || typeof agentName !== 'string') return null;
	return {
		kind: AGENT_MESSAGE_KIND,
		from: { sessionId, agentName, title: typeof from.title === 'string' ? from.title : null },
		text
	};
}

/**
 * The message as the receiving model reads it.
 *
 * Prefixed rather than passed through, because an unattributed line in the `user` role is a claim
 * that the person asked for it — which is the one thing a message from another agent must not be
 * able to say.
 */
export function agentMessageForModel(message: StoredAgentMessage): string {
	const { agentName, title, sessionId } = message.from;
	const label = title === null || title.trim().length === 0 ? agentName : `${agentName} · ${title}`;
	return `[message from agent ${label} (session ${sessionId})]\n${message.text}`;
}
