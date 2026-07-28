import { tags as t } from '@lezer/highlight';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const editorFont = 'var(--font-mono)';

export function buildCodeEditorTheme(options?: { invalid?: boolean }): Extension {
	const invalid = options?.invalid === true;

	return [
		EditorView.theme({
			'&': {
				fontSize: '0.75rem',
				lineHeight: '1.5',
				color: 'var(--foreground)',
				backgroundColor: 'var(--background)'
			},
			'.cm-scroller': {
				fontFamily: editorFont,
				lineHeight: '1.5'
			},
			'.cm-content': {
				padding: '0.375rem 0',
				caretColor: 'var(--foreground)'
			},
			'.cm-gutters': {
				fontFamily: editorFont,
				backgroundColor: 'var(--muted)',
				color: 'var(--muted-foreground)',
				borderRight: '1px solid var(--border)'
			},
			'&.cm-focused': { outline: 'none' },
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
				backgroundColor: 'color-mix(in oklab, var(--brand-500) 24%, transparent)'
			},
			'.cm-activeLine': {
				backgroundColor: 'color-mix(in oklab, var(--brand-500) 8%, transparent)'
			},
			'.cm-activeLineGutter': {
				backgroundColor: 'color-mix(in oklab, var(--brand-500) 10%, transparent)'
			}
		}),
		syntaxHighlighting(
			HighlightStyle.define([
				{ tag: t.keyword, color: 'var(--info)' },
				{ tag: [t.atom, t.bool, t.number], color: 'var(--brand-600)' },
				{ tag: t.string, color: 'var(--success)' },
				{ tag: t.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
				{
					tag: [t.function(t.variableName), t.definition(t.variableName)],
					color: 'var(--brand-700)'
				},
				{ tag: t.propertyName, color: 'var(--foreground)' },
				{ tag: t.operator, color: 'var(--muted-foreground)' },
				{ tag: t.punctuation, color: 'var(--muted-foreground)' }
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
