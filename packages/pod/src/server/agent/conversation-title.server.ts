import { AiChatResultSchema } from '@norbital-ai/platform-utils/runtime/binding';
import { z } from 'zod';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { mutateChatSession, readChatSession } from './chat-session.server.js';
import type { ChatSessionMessage } from '$lib/shared/agent/context-window.js';
import {
	automationReplayStorage,
	isAutomationEffectYield,
	replayAutomationAi
} from '$lib/server/run/automation-replay.server.js';
import { chat_session } from '@norbital-ai/platform-utils/system/workspace-schema';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

/** Visible only until the first-message title job succeeds. */
export const PENDING_CONVERSATION_TITLE = 'Workspace agent';

const MAX_TITLE_LENGTH = 72;
const generatedTitleSchema = z.object({
	title: z.string().trim().min(1).max(MAX_TITLE_LENGTH)
});

type PendingConversation = Pick<typeof chat_session.$inferSelect, 'norbital_id'>;

function firstUserMessage(messages: readonly ChatSessionMessage[]): string | null {
	for (const message of messages) {
		if (message.role !== 'user' || message.kind === 'summary') continue;
		const content = message.parts[0]?.content;
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
 * Turn one provider response into the stored title. Structured output is preferred; plain text
 * is accepted so a model that ignored the schema is not billed again.
 */
export function conversationTitleFromProviderText(text: string): string {
	let candidate = '';
	try {
		candidate = generatedTitleSchema.parse(JSON.parse(text)).title;
	} catch {
		candidate = text;
	}
	const compact = compactTitle(candidate);
	if (!compact) throw new Error('The conversation title model returned an empty title');
	return compact.length > MAX_TITLE_LENGTH
		? `${compact.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
		: compact;
}

/**
 * Ask the host model for one short label via durable replay. The guest never holds the admit
 * on OpenRouter — without a receipt replay store this throws instead of calling the model.
 */
export function generateConversationTitle(firstMessage: string): string {
	if (!automationReplayStorage.getStore()) {
		throw new Error(
			'Conversation title generation requires a durable step (automation/agent receipt).'
		);
	}
	const result = AiChatResultSchema.parse(
		replayAutomationAi({
			request: {
				kind: 'ai.turn',
				messages: [
					{
						role: 'system',
						content:
							'Name this conversation from the first user message. Return a specific, neutral title of 3 to 8 words. Do not answer the message, add quotation marks, or end with punctuation.'
					},
					{ role: 'user', content: firstMessage }
				],
				outputSchema: z.toJSONSchema(generatedTitleSchema)
			}
		})
	);
	return conversationTitleFromProviderText(result.text);
}

/** Generate and install one title only while the session still carries the pending marker. */
export async function runPendingConversationTitle(sessionId: string): Promise<boolean> {
	if (!automationReplayStorage.getStore()) return false;
	const session = await readChatSession(sessionId);
	if (session.title !== PENDING_CONVERSATION_TITLE) return false;
	const firstMessage = firstUserMessage(session.messages);
	if (!firstMessage) return false;
	const title = generateConversationTitle(firstMessage);
	return mutateChatSession(sessionId, (current) => {
		if (current.title !== PENDING_CONVERSATION_TITLE) return false;
		current.title = title;
		return true;
	});
}

/**
 * Drain first-message title work from durable tenant state.
 *
 * Titles are a host-effect. Without a receipt replay store the guest skips rather than blocking
 * the admit on the model. A failed inference leaves the placeholder for the next durable step;
 * a successful aggregate mutation emits the ordinary sync-outbox event.
 */
export async function runPendingConversationTitles(limit = 10): Promise<number> {
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const pending: readonly PendingConversation[] = await db
		.select({ norbital_id: chat_session.norbital_id })
		.from(chat_session)
		.where(
			and(
				eq(chat_session.title, PENDING_CONVERSATION_TITLE),
				isNull(chat_session.platform),
				eq(chat_session.visibility, 'personal'),
				sql`jsonb_array_length(${chat_session.messages}) > 0`
			)
		)
		.orderBy(asc(chat_session.norbital_created_at))
		.limit(Math.min(Math.max(limit, 1), 50));
	if (pending.length === 0) return 0;

	let titled = 0;
	for (const conversation of pending) {
		try {
			if (await runPendingConversationTitle(conversation.norbital_id)) titled += 1;
		} catch (error) {
			if (isAutomationEffectYield(error) || automationReplayStorage.getStore()?.pending) {
				throw error;
			}
			console.error('[agent-conversation-title]', {
				conversationId: conversation.norbital_id,
				error
			});
		}
	}
	return titled;
}
