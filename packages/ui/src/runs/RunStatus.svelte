<!--
@component
The live status of one automation run: queued, running with its progress, or its result or error.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { RunRow } from '../client/contract.js';
	/** `run` is a run id, a `RunHandle`, or a row already read (RunsFor), which is shown without a second read. */
	type RunStatusProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The automation's name (`jobs.send_pdf`). */
		automation: string;
		/** The run: its id or `RunHandle` (watched live), or a row already read (shown as given). */
		run: string | { readonly id: string } | RunRow;
		/** The automation's name; else its catalog label (`automations.<key>.label`), else its name in words (`jobs.send_pdf` → `Send pdf`). */
		title?: string;
		/** Download the run's files once when it succeeds: a run the person just started to get a file (a template, an export). */
		download?: boolean;
	};
</script>

<script lang="ts">
	// One run, live: status, progress, the error code, and download links for the files it returned.
	import { bolt_of } from '../client/context.js';
	import { watch } from '../read/live.svelte.js';
	import { humanize, msg, catalogText } from '../text/messages.js';
	import { progressOf, runFiles } from './facts.js';
	import ReadGate from '../read/ReadGate.svelte';

	let { ctx, automation, run, title, download = false }: RunStatusProps = $props();
	const bolt = $derived(bolt_of(ctx));
	const id = $derived(typeof run === 'string' ? run : run.id);
	const runs = $derived(bolt.runs);
	const given = $derived(
		typeof run !== 'string' && 'status' in run ? { rows: [run], next: null } : null
	);
	const live = watch(() =>
		runs === undefined || given !== null
			? null
			: runs(automation, { where: { id: { eq: id } }, limit: 1 })
	);
	const state = $derived(given !== null ? { kind: 'ready' as const, value: given } : live.state);
	// the browser saves each returned file once, through the same link the status shows (DOM side effect)
	let saved = false;
	$effect(() => {
		const row = state.kind === 'ready' ? state.value.rows[0] : undefined;
		if (!download || saved || row?.status !== 'succeeded') return;
		const anchors = document.querySelectorAll<HTMLAnchorElement>(
			`[data-run="${CSS.escape(row.id)}"] a[download]`
		);
		if (anchors.length === 0) return;
		saved = true;
		for (const anchor of anchors) anchor.click();
	});
</script>

{#if runs === undefined && given === null}
	<p role="status" class="text-muted-foreground text-sm" data-run={id}>
		{msg(bolt, 'run.unavailable', { id })}
	</p>
{:else}
	<ReadGate {ctx} {state} what={automation}>
		{#snippet children(page)}
			{@const r = page.rows[0]}
			{#if r === undefined}
				<p role="status" class="text-muted-foreground text-sm" data-run={id}>
					{msg(bolt, 'run.not_found', { id })}
				</p>
			{:else}
				{@const p = progressOf(r)}
				<div class="flex flex-col gap-1 text-sm" data-run={r.id} data-status={r.status}>
					<div class="flex items-center gap-2">
						<span class="font-medium"
							>{title ??
								(bolt.t(`automations.${automation}.label`) === `automations.${automation}.label`
									? humanize(automation.slice(automation.lastIndexOf('.') + 1))
									: bolt.t(`automations.${automation}.label`))}</span
						>
						<span class="text-muted-foreground"
							>{catalogText(bolt, `run.status.${r.status}`, r.status)}</span
						>
						{#if (r.attempt_count ?? 0) > 1}<span class="text-muted-foreground text-xs"
								>{msg(bolt, 'run.attempt', { n: r.attempt_count ?? 0 })}</span
							>{/if}
					</div>
					{#if p !== null && r.status === 'running'}<progress class="h-1 w-full" max="1" value={p}
						></progress>{/if}
					{#if r.error}<p role="alert" class="text-destructive text-xs">
							{r.error.message ?? r.error.code}
						</p>{/if}
					{#each runFiles(r) as f (f.id)}
						<a
							class="text-primary text-xs underline-offset-4 hover:underline"
							href={bolt.file_url(f)}
							download={f.name}>{msg(bolt, 'run.download', { name: f.name })}</a
						>
					{/each}
				</div>
			{/if}
		{/snippet}
	</ReadGate>
{/if}
