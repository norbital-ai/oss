<!--
@component
The live status of one automation run: queued, running with its progress, or its result or error.
-->
<script lang="ts" module>
	import type { RunRow } from './bolt.js';
	/** `run` is a run id, a `RunHandle`, or a row already read (RunsFor), which is shown without a second read. */
	export type RunStatusProps = { automation: string; run: string | { readonly id: string } | RunRow };
</script>

<script lang="ts">
	// One run, live (rule 56): status, progress, the error code, and download links for the files it returned.
	import { useBolt } from './bolt.js';
	import { watch } from './live.svelte.js';
	import { msg, progressOf, runFiles } from './model.js';
	import ReadGate from './ReadGate.svelte';

	let { automation, run }: RunStatusProps = $props();
	const bolt = useBolt();
	const id = $derived(typeof run === 'string' ? run : run.id);
	const runs = bolt.runs;
	const given = $derived(typeof run !== 'string' && 'status' in run ? { rows: [run], next: null } : null);
	const live = watch(() => runs === undefined || given !== null ? null : runs(automation, { where: { id: { eq: id } }, limit: 1 }));
	const state = $derived(given !== null ? { kind: 'ready' as const, value: given } : live.state);
</script>

{#if runs === undefined && given === null}
	<p role="status" class="text-muted-foreground text-sm" data-run={id}>{msg(bolt, 'run.unavailable', 'Run {id} started; its status is not readable here.', { id })}</p>
{:else}
	<ReadGate {state} what={automation}>
		{#snippet children(page)}
			{@const r = page.rows[0]}
			{#if r === undefined}
				<p role="status" class="text-muted-foreground text-sm" data-run={id}>{msg(bolt, 'run.notFound', 'Run {id} is not found or not yours to see.', { id })}</p>
			{:else}
				{@const p = progressOf(r)}
				<div class="flex flex-col gap-1 text-sm" data-run={r.id} data-status={r.status}>
					<div class="flex items-center gap-2">
						<span class="font-medium">{bolt.t(`automations.${automation}.label`) === `automations.${automation}.label` ? automation : bolt.t(`automations.${automation}.label`)}</span>
						<span class="text-muted-foreground">{msg(bolt, `run.status.${r.status}`, r.status)}</span>
						{#if (r.attempt_count ?? 0) > 1}<span class="text-muted-foreground text-xs">{msg(bolt, 'run.attempt', 'attempt {n}', { n: r.attempt_count ?? 0 })}</span>{/if}
					</div>
					{#if p !== null && r.status === 'running'}<progress class="h-1 w-full" max="1" value={p}></progress>{/if}
					{#if r.error}<p role="alert" class="text-destructive text-xs">{r.error.message ?? r.error.code}</p>{/if}
					{#each runFiles(r) as f (f.id)}
						<a class="text-primary text-xs underline-offset-4 hover:underline" href={bolt.fileUrl(f)} download={f.name}>{msg(bolt, 'run.download', 'Download {name}', { name: f.name })}</a>
					{/each}
				</div>
			{/if}
		{/snippet}
	</ReadGate>
{/if}
