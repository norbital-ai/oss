import { Marked } from 'marked';
import type { CommandItem } from './command-menu.js';

// Markdown to HTML for `ReadonlyMarkdown`: GFM; raw HTML in the text is shown as text, and a link or image may only point
// at http(s), mailto or a relative path, so a stored document can never script the page that shows it.
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const prettyJson = (text: string): string | undefined => {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return undefined;
	}
};
const marked = new Marked({
	gfm: true,
	async: false,
	renderer: {
		html: ({ text }) => escape(text),
		// A JSON fence is shown as JSON, not one dense line: the schema/transcript prompts are written to be read.
		code: ({ text, lang }) => {
			const json = lang?.toLowerCase() === 'json' ? prettyJson(text) : undefined;
			const body = escape(json ?? text);
			return `<pre><code${lang === undefined || lang === '' ? '' : ` class="language-${escape(lang)}"`}>${body}</code></pre>`;
		}
	},
	walkTokens(token) {
		if (
			(token.type === 'link' || token.type === 'image') &&
			!/^(https?:|mailto:|[#/.])/i.test(token.href)
		)
			token.href = '#';
	}
});
/** Markdown to HTML with `ReadonlyMarkdown`'s settings: raw HTML shown as text, links only to http(s), mailto or relative. */
export const markdownHtml = (text: string): string => marked.parse(text, { async: false });

/** The default `/` blocks of `MarkdownEditor`, each the Markdown that starts it (typed at a line's start). */
export const BLOCKS: readonly CommandItem[] = [
	{ id: 'h1', label: 'Heading 1', icon: 'lucide:heading-1', insert: '# ', group: 'Text' },
	{ id: 'h2', label: 'Heading 2', icon: 'lucide:heading-2', insert: '## ', group: 'Text' },
	{ id: 'h3', label: 'Heading 3', icon: 'lucide:heading-3', insert: '### ', group: 'Text' },
	{ id: 'quote', label: 'Quote', icon: 'lucide:quote', insert: '> ', group: 'Text' },
	{ id: 'bullets', label: 'Bulleted list', icon: 'lucide:list', insert: '- ', group: 'Lists' },
	{
		id: 'numbers',
		label: 'Numbered list',
		icon: 'lucide:list-ordered',
		insert: '1. ',
		group: 'Lists'
	},
	{
		id: 'checklist',
		label: 'Checklist',
		icon: 'lucide:list-checks',
		insert: '- [ ] ',
		group: 'Lists'
	},
	{
		id: 'table',
		label: 'Table',
		icon: 'lucide:table',
		insert: '| Column | Column |\n| --- | --- |\n|  |  |\n',
		group: 'Blocks'
	},
	{ id: 'code', label: 'Code block', icon: 'lucide:code', insert: '```\n\n```\n', group: 'Blocks' },
	{ id: 'divider', label: 'Divider', icon: 'lucide:minus', insert: '---\n', group: 'Blocks' }
];
