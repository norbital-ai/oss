// LogView's model (owner rule: logs read like Railway/Vercel): one dense line per event, filtered by level and text,
// following the tail, virtualized over measured row heights (the shared window math), older pages by cursor.
/** The log levels, least severe first. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
/** One log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];
/** One event; `rows` are oldest first. */
export type LogLine = { readonly id: string; readonly at: string | number; readonly level: LogLevel; readonly message: string; readonly source?: string };

/** An unmeasured row's height in px: one line of `text-xs leading-5` plus padding. */
export const ROW_ESTIMATE = 22;

/** The lines whose level is not hidden and whose message or source contains `q` (case-insensitive). */
export function filterLogs(rows: readonly LogLine[], hidden: Partial<Record<LogLevel, boolean>>, q: string): readonly LogLine[] {
	const needle = q.trim().toLowerCase();
	if (!needle && !LOG_LEVELS.some((l) => hidden[l])) return rows;
	return rows.filter((r) => !hidden[r.level] && (!needle || r.message.toLowerCase().includes(needle) || !!r.source?.toLowerCase().includes(needle)));
}

/** Within `slack` px of the bottom: the view follows the tail. */
export const atBottom = (p: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 8): boolean =>
	p.scrollHeight - p.scrollTop - p.clientHeight <= slack;

/** Whether scrolling here asks for the next older page. */
export const wantsOlder = (scrollTop: number, hasOlder: boolean, loading: boolean, threshold = 200): boolean =>
	hasOlder && !loading && scrollTop <= threshold;
