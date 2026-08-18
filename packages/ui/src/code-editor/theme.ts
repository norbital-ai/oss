import { tags as t } from '@lezer/highlight';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { CodeEditorLanguage } from './code-editor.types.js';

const editorFont = 'var(--font-mono)';
const proseFont = 'var(--font-sans)';

export function buildCodeEditorTheme(options?: {
	invalid?: boolean;
	language?: CodeEditorLanguage;
}): Extension {
	const invalid = options?.invalid === true;
	const markdown = options?.language === 'markdown';

	return [
		EditorView.theme({
			'&': {
				height: '100%',
				fontSize: markdown ? '0.875rem' : '0.75rem',
				lineHeight: markdown ? '1.6' : '1.5',
				color: 'var(--foreground)',
				backgroundColor: 'var(--background)'
			},
			'.cm-scroller': {
				fontFamily: markdown ? proseFont : editorFont,
				paddingTop: '2px',
				paddingBottom: '4px',
				lineHeight: markdown ? '1.6' : '1.5'
			},
			'.cm-content': {
				paddingTop: markdown ? '0.75rem' : '0',
				paddingBottom: markdown ? '1.25rem' : '0',
				paddingRight: '10px',
				caretColor: 'var(--foreground)'
			},
			'.cm-gutters': {
				fontFamily: editorFont,
				backgroundColor: 'var(--background)',
				color: 'var(--muted-foreground)',
				borderRight: 'none',
				paddingLeft: '2px',
				paddingRight: '4px'
			},
			'&.cm-focused': { outline: 'none' },
			'.cm-activeLine': { backgroundColor: 'transparent' },
			'.cm-activeLineGutter': { backgroundColor: 'transparent' },
			'&.cm-focused .cm-activeLine': {
				backgroundColor: 'color-mix(in oklab, var(--brand-500) 14%, transparent)'
			},
			'&.cm-focused .cm-activeLineGutter': {
				backgroundColor: 'color-mix(in oklab, var(--brand-500) 10%, transparent)',
				color: 'var(--foreground)'
			},
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
				backgroundColor: 'color-mix(in oklab, var(--brand-500) 24%, transparent)'
			},
			'.cm-selectionMatch, .cm-selectionMatch-main': {
				backgroundColor: 'color-mix(in oklab, var(--foreground) 8%, transparent)'
			},
			'.cm-tooltip': {
				backgroundColor: 'var(--popover)',
				color: 'var(--popover-foreground)',
				border: '1px solid var(--border)',
				borderRadius: '3px',
				boxShadow: '0 4px 14px color-mix(in oklab, var(--foreground) 12%, transparent)',
				fontFamily: editorFont
			},
			'.cm-tooltip.cm-tooltip-autocomplete > ul': {
				backgroundColor: 'var(--popover)',
				padding: '2px 0'
			},
			'.cm-tooltip-autocomplete ul li': {
				padding: '3px 8px',
				borderRadius: '2px',
				margin: '0 2px'
			},
			'.cm-tooltip-autocomplete ul li[aria-selected]': {
				backgroundColor: 'var(--accent)',
				color: 'var(--accent-foreground)'
			},
			'.cm-completionMatchedText': {
				color: 'var(--brand-600)',
				fontWeight: '600'
			},
			'.cm-completionDetail': {
				color: 'var(--muted-foreground)'
			},
			'.cm-md-h1': {
				fontSize: '1.35rem',
				fontWeight: '600',
				lineHeight: '1.35',
				paddingTop: '0.35em'
			},
			'.cm-md-h2': {
				fontSize: '1.2rem',
				fontWeight: '600',
				lineHeight: '1.4',
				paddingTop: '0.3em'
			},
			'.cm-md-h3': {
				fontSize: '1.05rem',
				fontWeight: '600',
				lineHeight: '1.45',
				paddingTop: '0.25em'
			},
			'.cm-md-h4, .cm-md-h5, .cm-md-h6': {
				fontSize: '0.95rem',
				fontWeight: '600',
				lineHeight: '1.5'
			},
			'.cm-md-h5, .cm-md-h6': {
				color: 'var(--muted-foreground)'
			},
			'.cm-md-codeblock': {
				backgroundColor: 'color-mix(in oklab, var(--muted) 72%, transparent)'
			},
			'.cm-md-blockquote': {
				color: 'var(--muted-foreground)',
				boxShadow: 'inset 3px 0 0 var(--border)'
			}
		}),
		syntaxHighlighting(
			HighlightStyle.define([
				{
					tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
					color: 'var(--muted-foreground)',
					fontStyle: 'italic'
				},
				{
					tag: [t.string, t.docString, t.special(t.string), t.attributeValue],
					color: 'var(--success)'
				},
				{ tag: t.regexp, color: 'var(--destructive)' },
				{ tag: [t.escape, t.character], color: 'var(--warning)' },
				{ tag: [t.number, t.integer, t.float, t.unit], color: 'var(--brand-600)' },
				{ tag: [t.bool, t.null, t.atom, t.self], color: 'var(--info)' },
				{
					tag: [t.keyword, t.modifier, t.definitionKeyword, t.operatorKeyword],
					color: 'var(--info)'
				},
				{ tag: [t.controlKeyword, t.moduleKeyword], color: 'var(--brand-700)' },
				{
					tag: [
						t.operator,
						t.punctuation,
						t.separator,
						t.bracket,
						t.squareBracket,
						t.paren,
						t.brace
					],
					color: 'var(--muted-foreground)'
				},
				{ tag: t.angleBracket, color: 'var(--muted-foreground)' },
				{ tag: [t.typeName, t.className, t.namespace], color: 'var(--info)' },
				{
					tag: [t.variableName, t.definition(t.variableName), t.local(t.variableName)],
					color: 'var(--foreground)'
				},
				{
					tag: [
						t.function(t.variableName),
						t.function(t.definition(t.variableName)),
						t.function(t.propertyName)
					],
					color: 'var(--brand-700)'
				},
				{
					tag: [t.propertyName, t.definition(t.propertyName), t.attributeName],
					color: 'var(--info)'
				},
				{ tag: t.tagName, color: 'var(--info)' },
				{ tag: t.heading, fontWeight: '600', color: 'var(--foreground)' },
				{ tag: t.strong, fontWeight: '600' },
				{ tag: t.emphasis, fontStyle: 'italic' },
				{ tag: t.strikethrough, textDecoration: 'line-through' },
				{ tag: [t.link, t.url], color: 'var(--brand-600)', textDecoration: 'underline' },
				{ tag: [t.quote, t.list], color: 'var(--muted-foreground)' },
				{
					tag: t.monospace,
					color: 'var(--brand-700)',
					fontFamily: editorFont
				},
				{
					tag: t.processingInstruction,
					color: 'color-mix(in oklab, var(--muted-foreground) 72%, transparent)',
					fontFamily: editorFont
				},
				{ tag: t.contentSeparator, color: 'var(--border)' },
				{ tag: t.meta, color: 'var(--muted-foreground)' },
				{ tag: t.inserted, color: 'var(--success)' },
				{ tag: t.deleted, color: 'var(--destructive)' },
				{ tag: t.changed, color: 'var(--info)' },
				{ tag: t.invalid, color: 'var(--destructive)' }
			])
		),
		EditorView.editorAttributes.of({
			class: invalid ? 'ring-[3px] ring-destructive/30' : ''
		})
	];
}

export function codeEditorShellClass(invalid?: boolean): string {
	return [
		'overflow-hidden rounded-sm border bg-background shadow-xs transition-[color,box-shadow]',
		invalid ? 'border-destructive' : 'border-input',
		'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50'
	].join(' ');
}
