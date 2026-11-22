import { Effect, Result, Schema } from 'effect';
import type { AgentRow } from '../../protocol/wire.ts';
import type { ShellApi } from '../api-types.ts';

export const EXPORT_PAGE_SIZE = 200;

export const refused = (
	answer: Result.Result<
		Effect.Success<ReturnType<ShellApi['agent']['stop']>>,
		Effect.Error<ReturnType<ShellApi['agent']['stop']>>
	>
) =>
	answer._tag === 'Failure'
		? answer.failure.message
		: answer.success.kind === 'refused'
			? answer.success.message
			: null;
export class AgentPanelFailed extends Schema.TaggedError<AgentPanelFailed>()('AgentPanelFailed', {
	message: Schema.String,
	cause: Schema.Defect()
}) {}

export type TranscriptPage = {
	readonly rows: readonly AgentRow[];
	readonly more: boolean;
	readonly first: number;
};

/**
 * Collects every message of a conversation by paginating backwards via `older` until no earlier
 * rows remain, merging and deduplicating in chronological order with the already-loaded rows.
 */
export const collectFullTranscript = <E>(
	conversation: string | null,
	loadedRows: readonly AgentRow[],
	beforeSeq: number | null,
	fetchOlder: (conversation: string, before: number, limit: number) => Effect.Effect<TranscriptPage, E>
): Effect.Effect<readonly AgentRow[], E> =>
	Effect.gen(function* () {
		if (conversation === null || beforeSeq === null) return loadedRows;
		const pages: (readonly AgentRow[])[] = [];
		let cursor: number | null = beforeSeq;
		while (cursor !== null) {
			const page: TranscriptPage = yield* fetchOlder(conversation, cursor, EXPORT_PAGE_SIZE);
			if (page.rows.length > 0) pages.push(page.rows);
			if (!page.more || page.rows.length === 0 || page.first >= cursor) break;
			cursor = page.first;
		}
		if (pages.length === 0) return loadedRows;
		const combined: AgentRow[] = [];
		const seen = new Set<string>();
		for (const page of pages.toReversed())
			for (const row of page)
				if (!seen.has(row.id)) {
					seen.add(row.id);
					combined.push(row);
				}
		for (const row of loadedRows)
			if (!seen.has(row.id)) {
				seen.add(row.id);
				combined.push(row);
			}
		return combined;
	});

/** Formats transcript rows as Markdown for `/export`. */
export const exportTranscriptMarkdown = (
	rows: readonly AgentRow[],
	title?: string | null
): string => {
	const body = rows
		.filter((r) => Boolean(r.text) && r.state !== 'cancelled' && r.state !== 'queued')
		.map((r) => `**${r.role}**: ${r.text}`)
		.join('\n\n');
	return title ? `# ${title}\n\n${body}\n` : body;
};

/** Triggers a browser download of a Markdown string. */
export const downloadMarkdown = (text: string, filename = 'conversation.md'): void => {
	const a = Object.assign(document.createElement('a'), {
		href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })),
		download: filename
	});
	a.click();
	URL.revokeObjectURL(a.href);
};
