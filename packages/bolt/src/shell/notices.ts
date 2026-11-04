// What the bell does with a member's notices. Attention is what it spends, so it answers "does this need me?" for the
// reader: notices addressed to them come first, everything about one record reads as one line, and workspace events,
// which go to every member, wait in a section of their own.
import type { NoticeRow } from '../protocol/schema.ts';

/** `announce`'s ids (engine/notifications/notify.ts). */
const WORKSPACE_EVENT = 'event:';

export type NoticeGroup = {
	readonly key: string;
	/** Newest first. */
	readonly rows: readonly NoticeRow[];
	readonly unread: readonly string[];
};
const grouped = (rows: readonly NoticeRow[]): readonly NoticeGroup[] => {
	const groups = new Map<string, NoticeRow[]>();
	for (const row of rows) {
		const key = row.link === null ? row.id : `${row.link.model}/${row.link.id}`;
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	return [...groups].map(([key, rows]) => ({
		key,
		rows,
		unread: rows.filter((row) => !row.read).map((row) => row.id)
	}));
};
/** `rows` newest first, as the inbox answers them: each list keeps that order by its newest notice. */
export const sortNotices = (rows: readonly NoticeRow[]) => ({
	forYou: grouped(rows.filter((row) => !row.id.startsWith(WORKSPACE_EVENT))),
	workspace: grouped(rows.filter((row) => row.id.startsWith(WORKSPACE_EVENT)))
});

const MINUTE = 60_000,
	HOUR = 60 * MINUTE,
	DAY = 24 * HOUR;
/** How long ago, in the fewest characters: `now`, `5m`, `3h`, `2d`, `6w`. */
export const noticeAge = (at: string, now: number): string => {
	const since = now - Date.parse(at);
	if (since < MINUTE) return 'now';
	if (since < HOUR) return `${Math.floor(since / MINUTE)}m`;
	if (since < DAY) return `${Math.floor(since / HOUR)}h`;
	if (since < 7 * DAY) return `${Math.floor(since / DAY)}d`;
	return `${Math.floor(since / (7 * DAY))}w`;
};
