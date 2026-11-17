<!--
@component
A CodeMirror code editor for JavaScript (also CEL and TypeScript expressions), JSON or plain text.
-->
<script lang="ts" module>
	import type { CodeEditorLanguage } from './code-setup.js';
	import type { LayoutSize } from '../layout/layout.shared.js';
	export type { CodeEditorLanguage };
	/**
	 * The props of `CodeEditor`: the text and `on_change`, the language, read-only and invalid states, and the minimum height.
	 */
	export type CodeEditorProps = {
		/** The text; an outside change replaces the document without echoing through `on_change`. */
		value: string;
		/** Called with the whole text on every edit. */
		on_change?(next: string): void;
		/** Syntax highlighting (default `plaintext`). */
		language?: CodeEditorLanguage;
		/** Not editable; shown on a muted background. */
		readonly?: boolean;
		/** Marks the editor invalid (a destructive border). */
		invalid?: boolean;
		/** CSS min-height of the editing area; one line is `2.25rem` (a field's height). */
		min_height?: string;
		/** `content` (default): its text's height, down to `min_height`; `fill`: the height left in its parent, scrolling inside. */
		size?: LayoutSize;
		/** The field's box (border, radius, shadow). Default true; false for an editor that is a whole pane. */
		framed?: boolean;
		/** Long lines wrap at the editor's width instead of scrolling sideways (an expression, prose). */
		wrap?: boolean;
		/** The id on the editing area, for `<label for>`. */
		id?: string;
		/** Accessible name of the editing area. */
		'aria-label'?: string;
		/** The id of the element that names the editing area. */
		'aria-labelledby'?: string;
	};
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import { cn } from '../primitives/utils.js';
	import { code_highlight, code_language, code_theme } from './code-setup.js';

	let {
		value,
		on_change,
		language = 'plaintext',
		readonly = false,
		invalid = false,
		min_height = '7rem',
		wrap = false,
		id,
		size = 'content',
		framed = true,
		'aria-label': ariaLabel,
		'aria-labelledby': ariaLabelledby
	}: CodeEditorProps = $props();

	/** Marks a transaction that mirrors `value` in, so it is not echoed back through `on_change`. */
	const External = Annotation.define<boolean>();
	const config = new Compartment();
	const tools = new Compartment();
	const settings = (): Extension => [
		code_language(language),
		wrap ? EditorView.lineWrapping : [],
		EditorState.readOnly.of(readonly),
		EditorView.editable.of(!readonly),
		EditorView.contentAttributes.of({
			...(ariaLabelledby
				? { 'aria-labelledby': ariaLabelledby }
				: { 'aria-label': ariaLabel ?? 'Code' }),
			...(id === undefined ? {} : { id })
		})
	];
	let view: EditorView | undefined;

	function mount(node: HTMLElement) {
		// Keep the editor usable immediately, even if the optional search and completion code fails to load.
		return untrack(() => {
			const editor = new EditorView({
				parent: node,
				state: EditorState.create({
					doc: value,
					extensions: [
						tools.of([]),
						code_theme,
						code_highlight,
						config.of(settings()),
						EditorView.updateListener.of((u) => {
							if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External)))
								on_change?.(u.state.doc.toString());
						})
					]
				})
			});
			view = editor;
			void import('codemirror').then(
				({ basicSetup }) => {
					if (view === editor) editor.dispatch({ effects: tools.reconfigure(basicSetup) });
				},
				() => undefined
			);
			return () => {
				editor.destroy();
				if (view === editor) view = undefined;
			};
		});
	}
	// an outside change (reset, another field's echo) replaces the text; the editor's own echo is equal and skipped
	$effect(() => {
		const doc = view?.state.doc.toString();
		if (view !== undefined && doc !== undefined && doc !== value)
			view.dispatch({
				changes: { from: 0, to: doc.length, insert: value },
				annotations: External.of(true)
			});
	});
	$effect(() => {
		view?.dispatch({ effects: config.reconfigure(settings()) });
	});
</script>

<div
	class={cn(
		'overflow-hidden bg-background',
		framed &&
			'rounded-sm border shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
		framed && (invalid ? 'border-destructive' : 'border-input'),
		readonly && 'bg-muted',
		size === 'fill' && 'h-full min-h-0'
	)}
	style:min-height={min_height}
	data-code-editor={language}
	{@attach mount}
></div>
