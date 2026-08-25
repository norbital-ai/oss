/**
 * What one agent says to another, as the receiving conversation stores it.
 *
 * `message_agent` writes into an adjacent agent's log, and the only role that log accepts for
 * something the agent did not itself produce is `user`. Stored as bare text that is exactly what it
 * became: a message the reader sees attributed to themselves, in their own bubble, in a conversation
 * they were not part of. The sender travels with the message so the panel can say who spoke, and so
 * the receiving agent's prompt says it too rather than presenting another agent's words as the
 * person's own instruction.
 *
 * The shape is owned by a Schema even though this module deliberately has no other Effect runtime
 * dependency: it is the one wire format between the runtime and the browser panel, and the panel
 * decodes it with the same Schema the runtime encodes with, so a divergence between the two sides
 * cannot compile.
 */

import { Option, Schema } from 'effect';

const AGENT_MESSAGE_KIND = 'agent_message';

/** The agent conversation a message came from, as much of it as the sender could name. */
const AgentMessageSender = Schema.Struct({
	agentId: Schema.String,
	agentName: Schema.String,
	/** The conversation's own title, which is what tells two sessions of one agent apart. */
	title: Schema.NullOr(Schema.String)
});
type AgentMessageSender = Schema.Schema.Type<typeof AgentMessageSender>;

export const StoredAgentMessage = Schema.Struct({
	kind: Schema.Literal(AGENT_MESSAGE_KIND),
	from: AgentMessageSender,
	text: Schema.String
});
export type StoredAgentMessage = Schema.Schema.Type<typeof StoredAgentMessage>;

const decodeStoredText = Schema.decodeUnknownOption(Schema.fromJsonString(StoredAgentMessage));
const decodeStoredValue = Schema.decodeUnknownOption(StoredAgentMessage);

export const encodeAgentMessage = (from: AgentMessageSender, text: string): StoredAgentMessage => ({
	kind: AGENT_MESSAGE_KIND,
	from,
	text
});

/**
 * Reads a stored record as an agent-to-agent message, or nothing when it is an ordinary one.
 *
 * Accepts the JSON string form as well as the decoded object: the log column is `jsonb`, and the
 * paths that reach this have handed it back both ways. Both forms decode through the same schema,
 * so a value that is not exactly the message shape reads as no message rather than as a half one.
 */
export function parseAgentMessage(content: unknown): StoredAgentMessage | null {
	const decoded =
		typeof content === 'string' ? decodeStoredText(content) : decodeStoredValue(content);
	return Option.match(decoded, {
		onNone: () => null,
		onSome: (message) => message
	});
}

/**
 * The message as the receiving model reads it.
 *
 * Prefixed rather than passed through, because an unattributed line in the `user` role is a claim
 * that the person asked for it — which is the one thing a message from another agent must not be
 * able to say.
 */
export function agentMessageForModel(message: StoredAgentMessage): string {
	const { agentName, title, agentId } = message.from;
	const label = title === null || title.trim().length === 0 ? agentName : `${agentName} · ${title}`;
	return `[message from agent ${label} (${agentId})]\n${message.text}`;
}
