import type { ConversationMessage } from './agents.js';

/** Queue order is independent of immutable transcript sequence. */
export function orderedQueuedMessages<
	A extends Pick<ConversationMessage, 'state' | 'priority' | 'sequence' | 'annotation'>
>(messages: readonly A[]): A[] {
	const position = (message: A) =>
		message.annotation?.tag === 'input'
			? (message.annotation.queuePosition ?? message.sequence)
			: message.sequence;
	return messages
		.filter((message) => message.state === 'queued')
		.sort(
			(left, right) =>
				Number(right.priority === 'steer') - Number(left.priority === 'steer') ||
				position(left) - position(right) ||
				left.sequence - right.sequence
		);
}
