import type { Prompt } from 'effect/unstable/ai';

type FixtureAuthor = Readonly<{
	readonly kind: 'human' | 'agent' | 'parent-agent' | 'tool' | 'system';
	readonly id?: string;
}>;

type FixtureMessage = Readonly<{
	readonly taskId: string;
	readonly message: Prompt.MessageEncoded;
	readonly runId?: string;
	readonly author?: FixtureAuthor;
	readonly annotation?: Readonly<Record<string, unknown>>;
}>;

const messageId = (sequence: number): string =>
	`00000000-0000-4000-8000-${String(sequence + 1).padStart(12, '0')}`;

const defaultAuthor = (message: Prompt.MessageEncoded): FixtureAuthor => {
	switch (message.role) {
		case 'user':
			return { kind: 'human' };
		case 'assistant':
			return { kind: 'agent' };
		case 'tool':
			return { kind: 'tool' };
		case 'system':
			return { kind: 'system' };
	}
};

/** Builds canonical durable agent_message rows containing complete encoded Effect messages. */
export const canonicalAgentRows = (source: ReadonlyArray<FixtureMessage>) =>
	source.map(({ taskId, message, runId, author, annotation }, sequence) => ({
		id: messageId(sequence),
		task_id: taskId,
		sequence,
		run_id: runId ?? null,
		author: author ?? defaultAuthor(message),
		message,
		annotation: annotation ?? null
	}));
