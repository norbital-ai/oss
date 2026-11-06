<!--
	A source edit as a unified diff: a path header per file, then its context, removed and added lines.
	The step's call carries the compact diff, never the model's answer; the panel only colours it.
-->
<script lang="ts">
	import type { Json } from '../../decl/values.ts';

	let {
		files,
		t
	}: {
		files: readonly { path: string; change?: string; diff: string }[];
		t: (key: string) => string;
	} = $props();
	const lineClass = (line: string) =>
		line.startsWith('+')
			? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
			: line.startsWith('-')
				? 'bg-destructive/10 text-destructive'
				: 'text-muted-foreground';
</script>

<div class="grid gap-2" data-diff>
	{#each files as file (file.path)}
		<section class="overflow-hidden rounded-md border bg-background">
			<header class="flex items-center gap-2 border-b bg-muted/40 px-2 py-1">
				<span class="truncate font-mono text-micro">{file.path}</span>
				{#if file.change !== undefined}<span class="ml-auto text-meta">{t(file.change)}</span>{/if}
			</header>
			{#if file.diff === ''}<p class="px-2 py-1.5 text-meta">{t('No textual change')}</p>{/if}
			{#if file.diff !== ''}
				<pre class="max-h-56 overflow-auto p-2 font-mono text-micro leading-4" data-diff-lines>{#each file.diff.split('\n') as line, i (i)}<span class="block whitespace-pre {lineClass(line)}">{line === '' ? ' ' : line}</span>{/each}</pre>
			{/if}
		</section>
	{/each}
</div>
