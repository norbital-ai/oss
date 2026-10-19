// A collapsed section's one line (`summary`), what it holds while closed: the set values, a text's first words, a file
// count. The words are ui's own keys (`ui.summary.*`), English outside a catalog.
import type { ViewBolt } from '../client/contract.js';
import { msg } from '../text/messages.js';

type Text = Pick<ViewBolt, 't'>;

/** The set values joined by ` · `, or "Not set". */
export function joinedSummary(bolt: Text, values: readonly unknown[]): string {
	const set = values.filter((v) => v !== null && v !== undefined && v !== '').map(String);
	return set.length === 0 ? msg(bolt, 'summary.notSet', 'Not set') : set.join(' · ');
}

/** A text's first 60 characters (an ellipsis past them), or "None". */
export function notesSummary(bolt: Text, value: unknown): string {
	const text = typeof value === 'string' ? value.trim() : '';
	if (text === '') return msg(bolt, 'summary.none', 'None');
	return text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text;
}

/** "No files" / "1 file" / "3 files" over every file field given (one file, a list, or nothing). */
export function filesSummary(bolt: Text, ...values: readonly unknown[]): string {
	const count = values.reduce<number>(
		(n, v) => n + (Array.isArray(v) ? v.length : v === null || v === undefined ? 0 : 1),
		0
	);
	return count === 0
		? msg(bolt, 'summary.noFiles', 'No files')
		: count === 1
			? msg(bolt, 'summary.oneFile', '1 file')
			: msg(bolt, 'summary.files', '{count} files', { count });
}
