<script lang="ts">
	import { Annotation, EditorState, StateEffect, type Extension } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import { cn } from '#lib/utils';
	import { basicSetup } from 'codemirror';
	import type { Action } from 'svelte/action';
	import { fromAction } from 'svelte/attachments';
	import { languageExtension } from './languages.js';
	import { buildCodeEditorTheme, codeEditorShellClass } from './theme.js';
	import type { CodeEditorLanguage } from './code-editor.types.js';

	const ExternalSyncAnnotation = Annotation.define<boolean>();

	let {
		value = '',
		language = 'plaintext' as CodeEditorLanguage,
		readonly = false,
		invalid = false,
		minHeight = '7rem',
		ariaLabel = 'Code editor',
		class: className = '',
		onValueChange
	}: {
		value?: string;
		language?: CodeEditorLanguage;
		readonly?: boolean;
		invalid?: boolean;
		minHeight?: string;
		ariaLabel?: string;
		class?: string;
		onValueChange?: (value: string) => void;
	} = $props();

	type EditorParameters = {
		value: string;
		language: CodeEditorLanguage;
		readonly: boolean;
		invalid: boolean;
		ariaLabel: string;
		onValueChange?: (value: string) => void;
	};

	function buildExtensions(
		parameters: EditorParameters,
		handleDocumentChange: (value: string) => void
	): Extension[] {
		return [
			basicSetup,
			...(parameters.language === 'markdown' ? [EditorView.lineWrapping] : []),
			buildCodeEditorTheme({ invalid: parameters.invalid, language: parameters.language }),
			languageExtension(parameters.language),
			EditorState.readOnly.of(parameters.readonly),
			EditorView.editable.of(!parameters.readonly),
			EditorView.contentAttributes.of({ 'aria-label': parameters.ariaLabel }),
			EditorView.updateListener.of((update) => {
				if (!update.docChanged) return;
				if (update.transactions.some((tr) => tr.annotation(ExternalSyncAnnotation))) return;
				handleDocumentChange(update.state.doc.toString());
			})
		];
	}

	const mountEditor: Action<HTMLElement, EditorParameters> = (node, initialParameters) => {
		let parameters = initialParameters;
		let externalValue = parameters.value;
		let setupKey = '';

		const nextSetupKey = (next: EditorParameters) =>
			`${next.language}::${next.readonly ? 'ro' : 'rw'}::${next.invalid ? 'bad' : 'ok'}::${next.ariaLabel}`;

		const view = new EditorView({
			state: EditorState.create({
				doc: parameters.value,
				extensions: buildExtensions(parameters, (nextValue) =>
					parameters.onValueChange?.(nextValue)
				)
			}),
			parent: node
		});
		setupKey = nextSetupKey(parameters);

		return {
			update(nextParameters) {
				const currentDocument = view.state.doc.toString();
				const nextKey = nextSetupKey(nextParameters);
				const externalValueChanged = nextParameters.value !== externalValue;
				const configurationChanged = nextKey !== setupKey;
				parameters = nextParameters;
				externalValue = parameters.value;
				setupKey = nextKey;

				if (!externalValueChanged && !configurationChanged) return;
				view.dispatch({
					...(!externalValueChanged || currentDocument === parameters.value
						? {}
						: {
								changes: {
									from: 0,
									to: currentDocument.length,
									insert: parameters.value
								},
								annotations: ExternalSyncAnnotation.of(true)
							}),
					...(configurationChanged
						? {
								effects: StateEffect.reconfigure.of(
									buildExtensions(parameters, (nextValue) => parameters.onValueChange?.(nextValue))
								)
							}
						: {})
				});
			},
			destroy() {
				view.destroy();
			}
		};
	};
</script>

{#if typeof window === 'undefined'}
	<div
		class={cn(codeEditorShellClass(invalid), className)}
		style:min-height={minHeight}
		aria-hidden="true"
	></div>
{:else}
	<div
		class={cn(codeEditorShellClass(invalid), className)}
		style:min-height={minHeight}
		{@attach fromAction(mountEditor, () => ({
			value: value ?? '',
			language,
			readonly,
			invalid,
			ariaLabel,
			onValueChange
		}))}
	></div>
{/if}

<style>
	:global(.cm-editor) {
		height: 100%;
		min-height: inherit;
	}

	:global(.cm-scroller) {
		min-height: inherit;
	}
</style>
