import type { ModelMessage } from '@tanstack/ai';

type FixtureMessage = Readonly<{
	readonly conversationId: string;
	readonly message: ModelMessage;
	readonly runId?: string;
	readonly appMetadata?: Readonly<Record<string, unknown>>;
}>;

/** Builds the two synced normalized collections from canonical SDK messages. */
export const canonicalAgentRows = (source: ReadonlyArray<FixtureMessage>) => {
	const fields: Array<{
		message_id: string;
		field: string;
		ordinal: number;
		payload: unknown;
	}> = [];
	const messages = source.map(({ conversationId, message, runId, appMetadata }, sequence) => {
		const messageId = message.id ?? `message-${sequence}`;
		if (Array.isArray(message.content)) {
			message.content.forEach((payload, ordinal) =>
				fields.push({ message_id: messageId, field: 'content', ordinal, payload })
			);
		}
		message.toolCalls?.forEach((payload, ordinal) =>
			fields.push({ message_id: messageId, field: 'toolCalls', ordinal, payload })
		);
		message.thinking?.forEach((payload, ordinal) =>
			fields.push({ message_id: messageId, field: 'thinking', ordinal, payload })
		);
		if (message.structuredOutput !== undefined) {
			fields.push({
				message_id: messageId,
				field: 'structuredOutput',
				ordinal: 0,
				payload: message.structuredOutput
			});
		}
		return {
			id: `row-${messageId}`,
			sequence,
			message_id: messageId,
			conversation_id: conversationId,
			role: message.role,
			name: message.name ?? null,
			run_id: runId ?? null,
			content_kind:
				message.content === null ? 'null' : typeof message.content === 'string' ? 'text' : 'parts',
			content_text: typeof message.content === 'string' ? message.content : null,
			tool_call_id: message.toolCallId ?? null,
			error: message.error ?? null,
			model_metadata: message.metadata ?? null,
			app_metadata: appMetadata ?? null
		};
	});
	return { messages, fields };
};
