import type { HostAiBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { z } from 'zod';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { updateRecord } from '$lib/server/collection/collection_ops.server.js';
import { requireRuntimeFacility } from '$lib/server/facilities.js';

/** Visible only until the first-message title job succeeds. */
export const PENDING_CONVERSATION_TITLE = 'Workspace agent';

const MAX_TITLE_LENGTH = 72;
const generatedTitleSchema = z.object({
	title: z.string().trim().min(1).max(MAX_TITLE_LENGTH)
});

type PendingConversation = {
	readonly norbital_id: string;
	readonly norbital_row_version: number;
	readonly first_message: string;
};

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

/**
 * Drain first-message title work from durable tenant state.
 *
 * The placeholder is the pending marker, so no second queue table or status concept is needed. A
 * failed inference leaves it in place for the next pg-boss tick; a successful optimistic update
 * emits the ordinary sync-outbox mutation and every open client receives the new title. The row
 * version prevents this background write from overwriting a title changed by a person meanwhile.
 */
export async function runPendingConversationTitles(limit = 10): Promise<number> {
	const ctx = getWorkspace({ provision: true });
	const pending = await ctx.tenantDb.query<PendingConversation>({
		text: `SELECT session.norbital_id,
		              session.norbital_row_version,
		              first_message.parts #>> '{0,content}' AS first_message
		         FROM chat_session AS session
		         JOIN LATERAL (
		                SELECT message.parts
		                  FROM chat_message AS message
		                 WHERE message.chat_id = session.norbital_id
		                   AND message.role = 'user'
		                   AND message.kind IS DISTINCT FROM 'summary'
		                 ORDER BY message.seq
		                 LIMIT 1
		              ) AS first_message ON TRUE
		        WHERE session.title = $1
		          AND session.platform IS NULL
		          AND session.visibility = 'personal'
		        ORDER BY session.norbital_created_at
		        LIMIT $2`,
		values: [PENDING_CONVERSATION_TITLE, Math.min(Math.max(limit, 1), 50)]
	});
	if (pending.rows.length === 0) return 0;

	const ai = requireRuntimeFacility('ai');
	let titled = 0;
	for (const conversation of pending.rows) {
		try {
			const title = await generateConversationTitle(ai, conversation.first_message);
			await updateRecord(
				ctx,
				'chat_session',
				conversation.norbital_id,
				{ title },
				{ isElevated: true, expectedVersion: conversation.norbital_row_version }
			);
			titled += 1;
		} catch (error) {
			console.error('[agent-conversation-title]', {
				conversationId: conversation.norbital_id,
				error
			});
		}
	}
	return titled;
}
