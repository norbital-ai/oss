<!--
	What a Studio look at the workspace returned, outside its folded step: a `view` role's result as one line — a small
	thumbnail of its screenshot (opening it full size), its caption (which environment, release, commit, viewport and
	when) and "View live" / "View preview", which shows that bundle in the panel's one previewer; a `logs` role's result as
	a folded list of its records, each coloured by level, under the same caption.
-->
<script lang="ts">
	import { Button, Icon } from '@norbital-ai/ui';
	import type { AgentRow } from '../../protocol/wire.ts';
	import { captionOf, logsOf } from './view.ts';

	let {
		step,
		t,
		zone,
		fileHref,
		onPreview
	}: {
		step: AgentRow;
		t: (key: string) => string;
		zone?: string | undefined;
		fileHref: (id: string) => string;
		onPreview: (url: string) => void;
	} = $props();

	const tool = $derived(step.tool);
	const caption = $derived(captionOf(tool?.about, zone));
	const image = $derived(
		tool?.studio === 'view' && !tool.failed
			? step.files?.find((f) => f.id !== undefined && f.mime.startsWith('image/'))?.id
			: undefined
	);
	const url = $derived(tool?.studio === 'view' && !tool.failed ? tool.about?.['url'] : undefined);
	const live = $derived(tool?.about?.['environment']?.toLowerCase() === 'live');
	const logs = $derived(logsOf(tool));
	const LEVEL: { readonly [level: string]: string } = {
		error: 'text-destructive',
		warn: 'text-warning'
	};
</script>

{#if url !== undefined || image !== undefined}
	<div
		class="mt-2 flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
		data-workspace-view
	>
		{#if image !== undefined}<a
				href={fileHref(image)}
				target="_blank"
				rel="noreferrer"
				class="shrink-0 overflow-hidden rounded border border-border"
				title={t('Workspace screenshot')}
				><img
					src={fileHref(image)}
					alt={caption || t('Workspace screenshot')}
					class="block h-9 w-14 object-cover object-top"
				/></a
			>{/if}
		<span class="min-w-0 flex-1 truncate text-muted-foreground" title={caption}>{caption}</span>
		{#if url !== undefined}<Button
				size="sm"
				variant="outline"
				class="shrink-0"
				onclick={() => onPreview(url)}
				data-open-preview>{t(live ? 'View live' : 'View preview')}</Button
			>{/if}
	</div>
{:else if logs !== null}
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
