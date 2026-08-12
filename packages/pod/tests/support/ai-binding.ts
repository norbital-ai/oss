import type {
	AiChatInput,
	AiChatResult,
	AiChatStreamEvent,
	HostAiBinding
} from '@norbital-ai/platform-utils/runtime/binding';

/** Adapt a deterministic final-result fake to the streaming host contract used by the Pod loop. */
export function testAiBinding(chat: (input: AiChatInput) => Promise<AiChatResult>): HostAiBinding {
	let nextId = 0;
	const streams = new Map<string, AiChatStreamEvent[]>();
	return {
		chat,
		async startStream(input) {
			const result = await chat(input);
			const id = `test-stream-${(nextId += 1)}`;
			streams.set(id, [
				...(result.reasoning ? [{ type: 'reasoning_part' as const, text: result.reasoning }] : []),
				...(result.text ? [{ type: 'text_part' as const, text: result.text }] : []),
				...(result.toolCalls ?? []).map((call) => ({ type: 'tool_call' as const, call })),
				{
					type: 'finish',
					stopReason: result.stopReason,
					...(result.usage !== undefined ? { usage: result.usage } : {})
				}
			]);
			return id;
		},
		async readStream(streamId) {
			const events = streams.get(streamId);
			if (!events) throw new Error('Unknown test AI stream');
			streams.delete(streamId);
			return { events, done: true };
		},
		async cancelStream(streamId) {
			streams.delete(streamId);
		}
	};
}
