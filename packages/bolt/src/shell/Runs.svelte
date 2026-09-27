<!--
	Settings → Automations (rule 48): every run, newest first, in ui's `Table` (search, filter and sort, CSV), re-read
	every few seconds while shown. A queued or running run has Stop (rule 56); a failed or stopped one has Retry, a new run
	of its automation with the same input. Opening a row shows the run as `runs.view` redacts it (`?run=<id>`).
-->
<script lang="ts">
	import { watch } from 'runed';
	import { Table } from '@norbital-ai/ui';
	import type { Json } from '../decl/values.ts';
	import type { RunView } from '../engine/runs/index.ts';
	import type { Act } from './Acts.svelte';
	import Acts from './Acts.svelte';
	import DetailSheet from './DetailSheet.svelte';
	import SystemPage from './SystemPage.svelte';
	import type { ShellApi, ShellBolt } from './runtime.ts';

	let { api, bolt, t, run = null, onRun }: { api: ShellApi; bolt: ShellBolt; t: (key: string) => string; run?: string | null; onRun: (id: string | null) => void } = $props();

	const EVERY_MS = 3_000;
	// ponytail: polled while the page is open; ride the live stream when `sys_run` gets a live read
	let rows = $state<RunView[] | null>(null);
	let one = $state<RunView | null>(null);
	let error = $state<string | null>(null);
	async function load(): Promise<void> {
		const r = await api.runs({ limit: 500 });
		if (r.ok) rows = r.value;
		else error = r.error.message;
		if (run === null) return void (one = null);
		const d = await api.run(run);
		one = d.ok ? d.value : null;
	}
	watch(() => run, () => {
		void load();
		const timer = setInterval(() => void load(), EVERY_MS);
		return () => clearInterval(timer);
	});

	const stoppable = (status: string) => status === 'queued' || status === 'running';
	const retryable = (status: string) => status === 'failed' || status === 'stopped';
	async function stop(id: string): Promise<void> {
		error = null;
		const r = await api.stopRun(id);
		if (!r.ok) error = r.error.message;
		await load();
	}
	async function retry(id: string): Promise<void> {
		error = null;
		const r = await api.run(id);
		if (!r.ok) return void (error = r.error.message);
		const o = await bolt.start(r.value.automation, (r.value.input ?? {}) as Json);
		if (o.kind === 'refused') error = o.message;
		await load();
	}
	const acts = (r: Pick<RunView, 'id' | 'status'>): Act[] => [
		...(stoppable(r.status) ? [{ label: t('Stop'), run: () => stop(r.id) }] : []),
		...(retryable(r.status) ? [{ label: t('Retry'), run: () => retry(r.id) }] : []),
	];
	const when = (v: string | null | undefined) => v ? new Date(v).toLocaleString(bolt.locale) : '—';
	const warnings = (r: RunView) => ((r.attempts ?? []) as { warnings?: string[] }[]).flatMap((a) => a.warnings ?? []);
</script>

{#snippet status({ row }: { row: RunView; value: unknown })}
	<span class="flex min-w-0 items-center gap-2" data-status={row.status}>
		<span class={row.status === 'failed' ? 'text-destructive' : row.status === 'running' ? 'text-foreground' : 'text-muted-foreground'}>{t(row.status)}</span>
		{#if row.status === 'running' && typeof row.progress === 'number'}<progress class="h-1 w-16" max="1" value={row.progress}></progress>{/if}
		{#if row.error}<span class="truncate text-xs text-destructive">{row.error.code}</span>{/if}
	</span>
{/snippet}
{#snippet at({ value }: { row: RunView; value: unknown })}<time class="tabular-nums">{when(typeof value === 'string' ? value : null)}</time>{/snippet}
{#snippet actions({ row }: { row: RunView; value: unknown })}<Acts acts={acts(row)} />{/snippet}

<SystemPage name="settings-automations" title={t('Automations')} description={t('Every automation run, newest first. Stop a queued or running run; retry a failed one.')} {error}>
	{#if rows === null}
		<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
	{:else}
		<Table of={rows} key="runs" onOpen={(r) => onRun(r.id)} toolbar={{ export: true }}
			columns={[{ field: 'automation', label: t('Automation') }, { field: 'status', label: t('Status'), cell: status }, { field: 'cause', label: t('Cause') },
				{ field: 'due_at', label: t('Due'), cell: at }, { field: 'started', label: t('Started'), cell: at }, { field: 'attempt_count', label: t('Attempts') },
				{ field: 'id', label: t('Actions'), hide: 'narrow', cell: actions }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('No runs yet.')}</p>{/snippet}
		</Table>
	{/if}
</SystemPage>

{#if run !== null && one !== null}
	{@const w = warnings(one)}
	<DetailSheet title={`${one.automation} · ${t(one.status)}`} acts={acts(one)} onClose={() => onRun(null)}
		fields={[{ label: t('Cause'), value: one.cause }, { label: t('Status'), value: t(one.status) }, { label: t('Due'), value: when(one.due_at) },
			{ label: t('Started'), value: when(one.started) }, { label: t('Attempts'), value: one.attempt_count },
			{ label: t('Error'), value: one.error === null ? undefined : `${one.error.code}${one.error.message ? `: ${one.error.message}` : ''}` },
			{ label: t('Warnings'), value: w.length === 0 ? undefined : w.join('\n') },
			{ label: t('Progress'), value: one.progress ?? undefined }, { label: t('Input'), value: one.input }, { label: t('Result'), value: one.result }]} />
{/if}
