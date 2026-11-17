import { jsonLanguage } from '@codemirror/lang-json';
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight';
import type { LogToken } from './logs.js';

const TOKENS = tagHighlighter([
	{ tag: t.propertyName, class: 'text-info' },
	{ tag: t.string, class: 'text-success' },
	{ tag: [t.number, t.bool, t.null], class: 'text-brand' },
	{ tag: [t.punctuation, t.separator, t.brace, t.squareBracket], class: 'text-muted-foreground' }
]);

/** A compact JSON payload as highlighted runs. */
export const json_tokens = (json: string): LogToken[] => {
	const tokens: LogToken[] = [];
	highlightCode(
		json,
		jsonLanguage.parser.parse(json),
		TOKENS,
		(text, cls) => tokens.push({ text, cls }),
		() => tokens.push({ text: ' ', cls: '' })
	);
	return tokens;
};
