import { lazy } from '../utilities/lazy.svelte.js';
import type { CommandItem } from './command-menu.js';

const parser = lazy(() => import('./markdown-parser.js'));

/** Markdown to HTML with `ReadonlyMarkdown`'s settings: raw HTML shown as text, links only to http(s), mailto or relative,
 * images only same-origin (a remote image becomes a link). `breaks` keeps each typed newline a line break. `undefined`
 * until the Markdown parser has loaded (with the first text asked for). */
export const markdown_html = (text: string, breaks = false): string | undefined =>
	parser()?.markdown_html(text, breaks);

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
