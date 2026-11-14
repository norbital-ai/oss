<!--
@component
One file's change as CodeMirror's unified diff: a header with its path and added and removed line counts, then, once
opened, the text with added lines green and removed lines red and long unchanged runs folded away. Closed by default:
the editor mounts only while open. It is as tall as its text; a parent that bounds it scrolls.
-->
<script lang="ts" module>
	import { Chunk, unifiedMergeView } from '@codemirror/merge';
	import { EditorState, Text } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import type { CodeEditorLanguage } from './code-setup.js';

	/** The props of `CodeDiff`. */
	export type CodeDiffProps = {
		/** The file's path, shown in the header. */
		path: string;
		/** The text before the change. */
		before: string;
		/** The text after the change. */
		after: string;
		/** Syntax highlighting (default `plaintext`). */
		language?: CodeEditorLanguage;
		/** Whether the diff is shown; bindable, closed by default. */
		open?: boolean;
	};

	const lines = (text: string) =>
		text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
	/** The lines added and removed between two texts, as CodeMirror's diff chunks them. */
	const diff_counts = (before: string, after: string) => {
		const a = Text.of(before.split('\n')),
			b = Text.of(after.split('\n'));
		return Chunk.build(a, b).reduce(
			(sum, chunk) => ({
				added: sum.added + lines(b.sliceString(chunk.fromB, chunk.toB)),
				removed: sum.removed + lines(a.sliceString(chunk.fromA, chunk.toA))
			}),
			{ added: 0, removed: 0 }
		);
	};

	const tint = (token: string, percent: number) =>
		`color-mix(in oklab, var(--${token}) ${percent}%, transparent)`;
	// the kit's tokens, so the colours follow the theme
	const changes = EditorView.theme({
		'.cm-deletedChunk': { backgroundColor: tint('destructive', 10) },
		'&.cm-merge-b .cm-changedLine': { backgroundColor: tint('success', 10) },
		'.cm-deletedChunk .cm-deletedText': { background: tint('destructive', 25) },
		'&.cm-merge-b .cm-changedText': { background: tint('success', 25) },
		'.cm-deletedLineGutter': { background: 'var(--destructive)' },
		'&.cm-merge-b .cm-changedLineGutter': { background: 'var(--success)' },
		'.cm-collapsedLines': {
			color: 'var(--muted-foreground)',
			background: 'var(--muted)',
			fontSize: '0.6875rem'
		}
	});
</script>

<script lang="ts">
	import { code_highlight, code_language, code_theme } from './code-setup.js';

	let {
		path,
		before,
		after,
		language = 'plaintext',
		open = $bindable(false)
	}: CodeDiffProps = $props();
	const counts = $derived(diff_counts(before, after));

	const mount = (parent: HTMLElement) => {
		const view = new EditorView({
			doc: after,
			parent,
			extensions: [
				code_theme,
				code_highlight,
				changes,
				code_language(language),
				EditorView.lineWrapping,
				EditorState.readOnly.of(true),
				EditorView.editable.of(false),
				EditorView.contentAttributes.of({ 'aria-label': path }),
				unifiedMergeView({
					original: before,
					mergeControls: false,
					gutter: true,
					collapseUnchanged: { margin: 3, minSize: 4 }
				})
			]
		});
		return () => view.destroy();
	};
</script>

<details class="overflow-hidden rounded-sm border bg-background" data-code-diff bind:open>
	<summary class="flex min-w-0 cursor-pointer items-center gap-2 bg-muted/40 px-2 py-1">
		<span class="min-w-0 flex-1 truncate font-mono text-micro" title={path}>{path}</span>
		<span class="shrink-0 font-mono text-micro text-success" data-added>+{counts.added}</span>
		<span class="shrink-0 font-mono text-micro text-destructive" data-removed
			>−{counts.removed}</span
		>
	</summary>
	{#if open}
		<div class="border-t text-micro" {@attach mount}></div>
	{/if}
</details>
