import type { AgentRow } from '../../protocol/schema.ts';

import type { SoundKind } from '../sounds.ts';

/** A turn's last row: its reply, or the reason it failed. */
const ending = (rows: readonly AgentRow[]) =>
	rows.findLast(
		(row) =>
			row.role === 'assistant' &&
			(row.tag === 'reply' || row.tag === 'failed') &&
			row.state !== 'streaming'
	);
// a held approval, or a click or field fill on the person's tab that waits for their confirmation (no answer yet)
const held = (row: AgentRow) =>
	row.state === 'confirm' ||
	row.tool?.approval !== undefined ||
	(row.tool?.pageResult === undefined &&
		(row.tool?.page?.click !== undefined || row.tool?.page?.type !== undefined));
// ponytail: a question mark outside code reads as asking the person; a structured "awaits the person" mark on the reply
// would be exact
const asks = (text: string | null) =>
	(text ?? '').replace(/```[\s\S]*?```|`[^`]*`/g, '').includes('?');

/**
 * The sound a turn's end makes, when it ended after `after` (an instant): a failure is an error; a held approval or a
 * question asks for the person; anything else is finished.
 */
export function endingSound(rows: readonly AgentRow[], after?: string): SoundKind | null {
	const end = ending(rows);
	if (end === undefined) return null;
	if (after !== undefined && (end.at === undefined || Date.parse(end.at) <= Date.parse(after)))
		return null;
	if (end.tag === 'failed') return 'error';
	return asks(end.text) || rows.some((row) => row.turn === end.turn && held(row))
		? 'input'
		: 'complete';
}

/**
 * Personal conversations idle now whose activity moved since the last answer, each with when it last moved before: one
 * may have just ended a turn, however briefly it ran.
 */
export function settled() {
	let prior: Map<string, { status: string; at: string }> | undefined;
	return (
		rows: readonly { id: string; status: string; at: string; integration: string | null }[]
	): { id: string; since: string }[] => {
		const before = prior;
		prior = new Map(rows.map((row) => [row.id, { status: row.status, at: row.at }]));
		if (before === undefined) return [];
		return rows.flatMap((row) => {
			const was = before.get(row.id);
			return row.integration === null &&
				row.status === 'idle' &&
				was !== undefined &&
				(was.status !== 'idle' || was.at !== row.at)
				? [{ id: row.id, since: was.at }]
				: [];
		});
	};
}

/** A turn's end the person has not seen yet. */
export type Awaiting = Exclude<SoundKind, 'notification'>;
const PRESSING = { complete: 1, input: 2, error: 3 } as const;
/** What the Norbius icon shows after a turn ends unseen: the most pressing ending still waiting. */
export const awaitingAfter = (current: Awaiting | null, kind: SoundKind): Awaiting | null =>
	kind === 'notification' || (current !== null && PRESSING[current] >= PRESSING[kind])
		? current
		: kind;

/** Only new events sound: opening history, switching chats and reconnecting never replay a chime. */
export function attention() {
	let previous:
		{ conversation: string; pending: Set<string>; ended: string | undefined } | undefined;
	return (conversation: string | null, rows: readonly AgentRow[]): SoundKind | null => {
		if (conversation === null) {
			previous = undefined;
			return null;
		}
		const pending = new Set(rows.filter(held).map((row) => row.id)),
			ended = ending(rows)?.id;
		const before = previous;
		previous = { conversation, pending, ended };
		if (before?.conversation !== conversation) return null;
		if ([...pending].some((id) => !before.pending.has(id))) return 'input';
		return ended !== undefined && ended !== before.ended ? endingSound(rows) : null;
	};
}
