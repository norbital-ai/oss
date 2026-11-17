// LogView's model (owner rule: logs read like Railway/Vercel): one fixed-height line per event, searched and filtered by
// CustomView's toolbar, following the tail, virtualized by the shared window math, older pages by cursor.
import { Result } from 'effect';
import { lazy } from '../utilities/lazy.svelte.js';
/** One log level. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** One event; `rows` are oldest first. */
export type LogLine = {
	readonly id: string;
	readonly at: string | number;
	readonly level: LogLevel;
	readonly message: string;
	/** What emitted it (a run), shown before the message; `null` for none. */
	readonly source: string | null;
};

/** A row's height in px: one line of `text-xs leading-5` plus padding; a longer message truncates. */
export const ROW_HEIGHT = 22;

/** A preview never highlights more than this many characters: the line truncates long before. */
const PREVIEW = 400;
/** One highlighted run of a preview; `cls` is empty for unstyled text. */
export type LogToken = { readonly text: string; readonly cls: string };
// the JSON parser loads with the first payload shown: until then a payload is one plain run
const payload = lazy(() => import('./log-tokens.js'));

/**
 * A message's one-line preview: its lead text, then its trailing JSON payload (also one JSON-encoded as a string)
 * compacted and highlighted. A message without a JSON payload is a single plain run.
 */
export function logPreview(message: string): readonly LogToken[] {
	const at = message.search(/[[{"]/);
	const value =
		at < 0
			? undefined
			: Result.getOrUndefined(
					Result.try(() => {
						const parsed: unknown = JSON.parse(message.slice(at));
						if (typeof parsed !== 'string') return parsed;
						const inner: unknown = JSON.parse(parsed);
						return inner;
					})
				);
	if (value === null || typeof value !== 'object')
		return [{ text: message.slice(0, PREVIEW), cls: '' }];
	const json = JSON.stringify(value).slice(0, PREVIEW);
	return [
		{ text: message.slice(0, at), cls: '' },
		...(payload()?.json_tokens(json) ?? [{ text: json, cls: '' }])
	];
}

/** Within `slack` px of the bottom: the view follows the tail. */
export const atBottom = (
	p: { scrollTop: number; clientHeight: number; scrollHeight: number },
	slack = 8
): boolean => p.scrollHeight - p.scrollTop - p.clientHeight <= slack;

/** Whether scrolling here asks for the next older page. */
export const wantsOlder = (
	scrollTop: number,
	hasOlder: boolean,
	loading: boolean,
	threshold = 200
): boolean => hasOlder && !loading && scrollTop <= threshold;
