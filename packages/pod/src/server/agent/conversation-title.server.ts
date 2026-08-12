import type { HostAiBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { z } from 'zod';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { requireRuntimeFacility } from '$lib/server/facilities.js';
import { mutateChatSession, readChatSession } from './chat-session.server.js';

/** Visible only until the first-message title job succeeds. */
export const PENDING_CONVERSATION_TITLE = 'Workspace agent';

const MAX_TITLE_LENGTH = 72;
const generatedTitleSchema = z.object({
	title: z.string().trim().min(1).max(MAX_TITLE_LENGTH)
});

type PendingConversation = {
	readonly norbital_id: string;
	readonly messages: readonly unknown[];
};

function firstUserMessage(messages: readonly unknown[]): string | null {
	for (const candidate of messages) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
		const message = candidate as Record<string, unknown>;
		if (message.role !== 'user' || message.kind === 'summary') continue;
		const parts = message.parts;
		if (!Array.isArray(parts)) continue;
		const stored = parts[0];
		if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
		const content = (stored as Record<string, unknown>).content;
		if (typeof content === 'string' && content.trim()) return content;
	}
	return null;
}

function compactTitle(value: string): string {
	return value
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '')
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
		.replace(/\s+/g, ' ')
		.replace(/[.!?。！？]+$/, '')
		.trim();
}

/**
 * Ask the host model for one short label. Structured output is preferred, while the plain-text
 * fallback prevents a model that ignored the schema from being billed again every minute forever.
 */
export async function generateConversationTitle(
	ai: Pick<HostAiBinding, 'chat'>,
	firstMessage: string
): Promise<string> {
	const result = await ai.chat({
		messages: [
			{
				role: 'system',
				content:
					'Name this conversation from the first user message. Return a specific, neutral title of 3 to 8 words. Do not answer the message, add quotation marks, or end with punctuation.'
			},
			{ role: 'user', content: firstMessage }
		],
		outputSchema: z.toJSONSchema(generatedTitleSchema)
	});

	let candidate = '';
	try {
		candidate = generatedTitleSchema.parse(JSON.parse(result.text)).title;
	} catch {
		candidate = result.text;
	}
	const compact = compactTitle(candidate);
	if (!compact) throw new Error('The conversation title model returned an empty title');
	return compact.length > MAX_TITLE_LENGTH
		? `${compact.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
		: compact;
}

/** Generate and install one title only while the session still carries the pending marker. */
export async function runPendingConversationTitle(sessionId: string): Promise<boolean> {
	const session = await readChatSession(sessionId);
	if (session.title !== PENDING_CONVERSATION_TITLE) return false;
	const firstMessage = firstUserMessage(session.messages);
	if (!firstMessage) return false;
	const title = await generateConversationTitle(requireRuntimeFacility('ai'), firstMessage);
	return mutateChatSession(sessionId, (current) => {
		if (current.title !== PENDING_CONVERSATION_TITLE) return false;
		current.title = title;
		return true;
	});
}

/**
 * Drain first-message title work from durable tenant state.
 *
 * The placeholder is the pending marker, so no second queue table or status concept is needed. A
 * failed inference leaves it in place for the next pg-boss tick; a successful aggregate mutation
 * emits the ordinary sync-outbox event and every open client receives the new title. The mutation
 * rechecks the pending marker under the session row lock, so it cannot overwrite a newer title.
 */
export async function runPendingConversationTitles(limit = 10): Promise<number> {
	const ctx = getWorkspace({ provision: true });
	const pending = await ctx.tenantDb.query<PendingConversation>({
		text: `SELECT session.norbital_id,
		              session.messages
		         FROM chat_session AS session
		        WHERE session.title = $1
		          AND session.platform IS NULL
		          AND session.visibility = 'personal'
		          AND jsonb_array_length(session.messages) > 0
		        ORDER BY session.norbital_created_at
		        LIMIT $2`,
		values: [PENDING_CONVERSATION_TITLE, Math.min(Math.max(limit, 1), 50)]
	});
	if (pending.rows.length === 0) return 0;

	let titled = 0;
	for (const conversation of pending.rows) {
		try {
			if (await runPendingConversationTitle(conversation.norbital_id)) titled += 1;
		} catch (error) {
			console.error('[agent-conversation-title]', {
				conversationId: conversation.norbital_id,
				error
			});
		}
	}
	return titled;
}
