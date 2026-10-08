<!--
@component
A CodeMirror code editor for JavaScript (also CEL and TypeScript expressions), JSON or plain text.
-->
<script lang="ts" module>
	/** Code in CodeMirror: `javascript` (also CEL and TypeScript expressions), `json`, or `plaintext`. */
	export type CodeEditorLanguage = 'javascript' | 'json' | 'plaintext';
	/**
	 * The props of `CodeEditor`: the text and `onChange`, the language, read-only and invalid states, and the minimum height.
	 */
	export type CodeEditorProps = {
		value: string;
		onChange?(next: string): void;
		language?: CodeEditorLanguage;
		readonly?: boolean;
		invalid?: boolean;
		/** CSS min-height of the editing area; one line is `2.25rem` (a field's height). */
		minHeight?: string;
		/** Long lines wrap at the editor's width instead of scrolling sideways (an expression, prose). */
		wrap?: boolean;
		id?: string;
		class?: string;
		'aria-label'?: string;
	};
</script>

<script lang="ts">
	import { javascript } from '@codemirror/lang-javascript';
	import { json } from '@codemirror/lang-json';
	import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
	import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import { tags as t } from '@lezer/highlight';
	import { basicSetup } from 'codemirror';
	import { cn } from '../primitives/utils.js';

	let { value, onChange, language = 'plaintext', readonly = false, invalid = false, minHeight = '7rem', wrap = false, id, class: className, 'aria-label': ariaLabel }: CodeEditorProps = $props();

	const theme = EditorView.theme({
		'&': { height: '100%', minHeight: 'inherit', fontSize: '0.75rem', color: 'var(--foreground)', backgroundColor: 'transparent' },
		'&.cm-focused': { outline: 'none' },
		'.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5', minHeight: 'inherit' },
		'.cm-content': { caretColor: 'var(--foreground)', paddingRight: '10px' },
		'.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted-foreground)', border: 'none' },
		'.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
		'&.cm-focused .cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--brand-500) 10%, transparent)' },
		'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in oklab, var(--brand-500) 24%, transparent)' },
		'.cm-tooltip': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)', border: '1px solid var(--border)', borderRadius: '4px' },
		'.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' }
	});
	const highlight = syntaxHighlighting(HighlightStyle.define([
		{ tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--muted-foreground)', fontStyle: 'italic' },
		{ tag: [t.string, t.special(t.string)], color: 'var(--success)' },
		{ tag: [t.number, t.integer, t.float], color: 'var(--brand-600)' },
		{ tag: [t.bool, t.null, t.atom, t.keyword, t.operatorKeyword, t.typeName, t.propertyName], color: 'var(--info)' },
		{ tag: [t.controlKeyword, t.moduleKeyword, t.function(t.variableName), t.function(t.propertyName)], color: 'var(--brand-700)' },
		{ tag: [t.operator, t.punctuation, t.bracket, t.paren, t.brace, t.squareBracket], color: 'var(--muted-foreground)' },
		{ tag: t.invalid, color: 'var(--destructive)' }
	]));
	const lang = (l: CodeEditorLanguage): Extension => (l === 'javascript' ? javascript() : l === 'json' ? json() : []);
	/** Marks a transaction that mirrors `value` in, so it is not echoed back through `onChange`. */
	const External = Annotation.define<boolean>();
	const config = new Compartment();
	const settings = (): Extension => [lang(language), wrap ? EditorView.lineWrapping : [], EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly),
		EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? 'Code', ...(id === undefined ? {} : { id }) })];
	let view: EditorView | undefined;

	function mount(node: HTMLElement) {
		view = new EditorView({
			parent: node,
			state: EditorState.create({ doc: value, extensions: [basicSetup, theme, highlight, config.of(settings()),
				EditorView.updateListener.of((u) => {
					if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) onChange?.(u.state.doc.toString());
				})] })
		});
		return () => { view?.destroy(); view = undefined; };
	}
	// an outside change (reset, another field's echo) replaces the text; the editor's own echo is equal and skipped
	$effect(() => {
		const doc = view?.state.doc.toString();
		if (view !== undefined && doc !== value) view.dispatch({ changes: { from: 0, to: doc!.length, insert: value }, annotations: External.of(true) });
	});
	$effect(() => { view?.dispatch({ effects: config.reconfigure(settings()) }); });
</script>

<div
	class={cn('overflow-hidden rounded-sm border bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
		invalid ? 'border-destructive' : 'border-input', readonly && 'bg-muted', className)}
	style:min-height={minHeight}
	data-code-editor={language}
	{@attach mount}
></div>
