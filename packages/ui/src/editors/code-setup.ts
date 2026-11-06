// The setup every CodeMirror surface shares: its theme over the kit's tokens, the code colours and the languages.
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { codeHighlighter } from './highlight.js';

/** Code in CodeMirror: `javascript` (also CEL and TypeScript expressions), `json`, or `plaintext`. */
export type CodeEditorLanguage = 'javascript' | 'json' | 'plaintext';
/** The language's parser and highlighting. */
export const codeLanguage = (language: CodeEditorLanguage): Extension =>
	language === 'javascript' ? javascript() : language === 'json' ? json() : [];
/** The kit's tokens over CodeMirror. StyleMod retains mounted rules for the document's lifetime: instances share this. */
export const codeTheme = EditorView.theme({
	'&': {
		height: '100%',
		minHeight: 'inherit',
		fontSize: '0.75rem',
		color: 'var(--foreground)',
		backgroundColor: 'transparent'
	},
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5', minHeight: 'inherit' },
	'.cm-content': { caretColor: 'var(--foreground)', paddingRight: '10px' },
	'.cm-scroller .cm-cursor, .cm-scroller .cm-dropCursor': {
		borderLeftColor: 'var(--foreground)'
	},
	'.cm-gutters': {
		backgroundColor: 'transparent',
		color: 'var(--muted-foreground)',
		border: 'none'
	},
	'.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
	'&.cm-focused .cm-activeLine': {
		backgroundColor: 'color-mix(in oklab, var(--brand) 10%, transparent)'
	},
	'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
		{
			backgroundColor: 'var(--accent)'
		},
	'.cm-content ::selection, .cm-content::selection': {
		backgroundColor: 'var(--accent)',
		color: 'var(--accent-foreground)'
	},
	'.cm-tooltip': {
		backgroundColor: 'var(--popover)',
		color: 'var(--popover-foreground)',
		border: '1px solid var(--border)',
		borderRadius: '4px'
	},
	'.cm-tooltip-autocomplete ul li[aria-selected]': {
		backgroundColor: 'var(--accent)',
		color: 'var(--accent-foreground)'
	}
});
/** The code colours as an extension. */
export const codeHighlight = syntaxHighlighting(codeHighlighter);
