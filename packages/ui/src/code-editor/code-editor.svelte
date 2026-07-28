<script lang="ts">
	import { javascript } from '@codemirror/lang-javascript';
	import { json } from '@codemirror/lang-json';
	import { Annotation, EditorState, type Extension } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import { cn } from '#lib/utils';
	import { basicSetup } from 'codemirror';
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
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

	let mountRef = $state<{ view: EditorView } | null>(null);
	let syncedValue = $state('');

	const setupKey = $derived(
		`${language}::${readonly ? 'ro' : 'rw'}::${invalid ? 'bad' : 'ok'}::${ariaLabel}`
	);

	function languageExtension(): Extension {
		switch (language) {
			case 'javascript':
				return javascript();
			case 'json':
				return json();
			default:
				return [];
		}
	}

	function buildExtensions(): Extension[] {
		return [
			basicSetup,
			buildCodeEditorTheme({ invalid }),
			languageExtension(),
			EditorState.readOnly.of(readonly),
			EditorView.editable.of(!readonly),
			EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
			EditorView.updateListener.of((update) => {
				if (!update.docChanged) return;
				if (update.transactions.some((tr) => tr.annotation(ExternalSyncAnnotation))) return;
				const next = update.state.doc.toString();
				syncedValue = next;
				onValueChange?.(next);
			})
		];
	}

	function syncDocument(nextValue: string): void {
		const mount = mountRef;
		if (!mount) return;
		const current = mount.view.state.doc.toString();
		if (current === nextValue) return;
		mount.view.dispatch({
			changes: { from: 0, to: current.length, insert: nextValue },
			annotations: ExternalSyncAnnotation.of(true)
		});
	}

	$effect(() => {
		const nextValue = value ?? '';
		if (nextValue === syncedValue) return;
		syncedValue = nextValue;
		syncDocument(nextValue);
	});

	let attachmentCache: { setupKey: string; attachment: Attachment<HTMLElement> } | null = null;

	function createAttachment(): Attachment<HTMLElement> {
		return (node) => {
			if (typeof window === 'undefined') return;

			return untrack(() => {
				const initial = value ?? '';
				syncedValue = initial;

				const view = new EditorView({
					state: EditorState.create({
						doc: initial,
						extensions: buildExtensions()
					}),
					parent: node
				});

				mountRef = { view };

				return () => {
					view.destroy();
					if (mountRef?.view === view) mountRef = null;
				};
			});
		};
	}

	function editorAttachment(): Attachment<HTMLElement> {
		if (attachmentCache?.setupKey === setupKey) return attachmentCache.attachment;
		const attachment = createAttachment();
		attachmentCache = { setupKey, attachment };
		return attachment;
	}
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
		{@attach editorAttachment()}
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
