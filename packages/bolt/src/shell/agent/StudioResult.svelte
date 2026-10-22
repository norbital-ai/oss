<!--
	What a Studio look at the workspace returned, outside its folded step: a `logs` role's result as a folded list of its
	records, each coloured by level, under its caption (which environment, release, commit and when). A `view` role's
	screenshot is one of the step's made files; its bundle opens from the panel header's Preview button.
-->
<script lang="ts">
	import { Icon } from '@norbital-ai/ui';
	import type { AgentRow } from '../../protocol/wire.ts';
	import { captionOf, logsOf } from './view.ts';

	let {
		step,
		t,
		zone
	}: {
		step: AgentRow;
		t: (key: string) => string;
		zone?: string | undefined;
	} = $props();

	const tool = $derived(step.tool);
	const caption = $derived(captionOf(tool?.about, zone));
	const logs = $derived(logsOf(tool));
	const LEVEL: { readonly [level: string]: string } = {
		error: 'text-destructive',
		warn: 'text-warning'
	};
</script>

{#if logs !== null}
	<details class="mt-2 rounded-xl border border-border bg-card text-xs" data-workspace-logs>
		<summary class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-muted-foreground">
			<Icon name="lucide:scroll-text" class="size-3.5 shrink-0" />
			<span class="shrink-0 font-medium"
				>{`${logs.length} ${t(logs.length === 1 ? 'log line' : 'log lines')}`}</span
			>
			<span class="min-w-0 truncate" title={caption}>{caption}</span>
		</summary>
		<ol class="max-h-64 overflow-auto border-t border-border px-3 py-1.5 font-mono">
			{#each logs as line, i (i)}
				<li class="flex gap-2 {LEVEL[line.level] ?? 'text-foreground'}" data-level={line.level}>
					<span class="shrink-0 opacity-60">{line.at.slice(11, 19)}</span>
					<span class="shrink-0 uppercase">{line.level}</span>
					<span class="min-w-0 break-words whitespace-pre-wrap">{line.message}</span>
				</li>
			{/each}
		</ol>
	</details>
{/if}
