import { javascriptLanguage } from '@codemirror/lang-javascript';
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight';

/** Code colours as utility classes: the editor's highlighting and a one-line preview share them. */
export const codeHighlighter = tagHighlighter([
	{ tag: [t.comment, t.lineComment, t.blockComment], class: 'text-muted-foreground italic' },
	{ tag: [t.string, t.special(t.string)], class: 'text-success' },
	{ tag: [t.number, t.integer, t.float], class: 'text-brand-600' },
	{
		tag: [t.bool, t.null, t.atom, t.keyword, t.operatorKeyword, t.typeName, t.propertyName],
		class: 'text-info'
	},
	{
		tag: [t.controlKeyword, t.moduleKeyword, t.function(t.variableName), t.function(t.propertyName)],
		class: 'text-brand-700'
	},
	{
		tag: [t.operator, t.punctuation, t.bracket, t.paren, t.brace, t.squareBracket],
		class: 'text-muted-foreground'
	},
	{ tag: t.invalid, class: 'text-destructive' }
]);

/** An expression as highlighted tokens on one line: each line break becomes a space. */
export function highlightedLine(code: string): { text: string; class: string }[] {
	const tokens: { text: string; class: string }[] = [];
	highlightCode(
		code,
		javascriptLanguage.parser.parse(code),
		codeHighlighter,
		(text, classes) => tokens.push({ text, class: classes }),
		() => tokens.push({ text: ' ', class: '' })
	);
	return tokens;
}
