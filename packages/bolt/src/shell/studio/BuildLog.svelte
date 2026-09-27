<!--
	A build's log (staging's bundle-logs "Build details"): an overline and the lines in a muted monospace block, each tinted
	by its level.
-->
<script lang="ts">
	import { Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { StudioLogLine } from '../studio.ts';

	let { lines, t }: { lines: readonly StudioLogLine[]; t: (key: string) => string } = $props();
	const tone = (level: StudioLogLine['level']) => level === 'error' ? 'text-destructive' : level === 'warn' ? 'text-amber-800 dark:text-amber-300' : 'text-foreground';
</script>

<Stack as="section" gap="sm">
	<h3 class="text-overline">{t('Build details')}</h3>
	{#if lines.length === 0}
		<p class="text-meta">{t('No build output.')}</p>
	{:else}
		<Scroll name={t('Build details')} class="max-h-[28rem]">
			<ul class="rounded-md bg-muted/35 p-3 font-mono text-xs leading-5">
				{#each lines as line, i (i)}
					<li class="break-all whitespace-pre-wrap {tone(line.level)}"><span class="text-muted-foreground">{line.at}</span> <span class="uppercase">{line.level}</span> {line.message}</li>
				{/each}
			</ul>
		</Scroll>
	{/if}
</Stack>
