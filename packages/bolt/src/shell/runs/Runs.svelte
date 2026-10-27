<!--
	Settings → Automations (rule 48): every run, newest first, in ui's `Table` (search, filter and sort, CSV), re-read
	every few seconds while shown. A queued or running run has Stop (rule 56); a failed or stopped one has Retry, a new run
	of its automation with the same input. Run now starts any automation the member may start that needs no input. Opening a row shows the run as `runs.view` redacts it (`?run=<id>`).
-->
<script lang="ts">
	import { fork, observe } from '@norbital-ai/ui/effect';
	import { Array as EffectArray, Effect, Predicate, Schedule, Stream } from 'effect';
	import { Button, Combobox, EmptyState, Show, Table, useKinds } from '@norbital-ai/ui';
	import type { RunView } from '../../engine/runs/index.ts';
	import type { Act } from '../Acts.svelte';
	import Acts from '../Acts.svelte';
	import DetailSheet from '../DetailSheet.svelte';
	import SystemPage from '../SystemPage.svelte';
	import automationsBanner from '../assets/banners/automations.jpg';
	import type { ShellBolt } from '../runtime.ts';
	import type { ShellApi } from '../api-types.ts';

	let {
		api,
		bolt,
		t,
		startable = [],
		run = null,
		onRun
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		startable?: readonly { readonly name: string; readonly description: string }[];
		run?: string | null;
		onRun: (id: string | null) => void;
	} = $props();

	const kinds = useKinds();
	const runs = observe(() =>
		Stream.fromEffectSchedule(api.runs({ limit: 500 }), Schedule.spaced('3 seconds'))
	);
	const detail = observe(() =>
		run === null ? null : Stream.fromEffectSchedule(api.run(run), Schedule.spaced('3 seconds'))
	);
	const runRow = (r: RunView) => ({
		id: r.id,
		automation: r.automation,
		cause: r.cause,
		status: r.status,
		due_at: r.due_at,
		started: r.started,
		progress: r.progress,
		error_code: r.error?.code ?? null,
		attempt_count: r.attempt_count
	});
	type RunRow = ReturnType<typeof runRow>;
	const rows = $derived($runs?.map(runRow) ?? null);
	const one = $derived($detail ?? null);
	let mutationError = $state<string | null>(null);
	const error = $derived(mutationError ?? runs.error?.message ?? detail.error?.message ?? null);

	const stoppable = (status: string) => status === 'queued' || status === 'running';
	const retryable = (status: string) => status === 'failed' || status === 'stopped';
	const stop = Effect.fn('Runs.stop')(function* (id: string) {
		mutationError = null;
		const r = yield* Effect.result(api.stopRun(id));
		if (r._tag === 'Failure') mutationError = r.failure.message;
	});
	const retry = Effect.fn('Runs.retry')(function* (id: string) {
		mutationError = null;
		const r = yield* Effect.result(api.run(id));
		if (r._tag === 'Failure') return void (mutationError = r.failure.message);
		const o = yield* bolt.start(r.success.automation, r.success.input ?? {});
		if (o.kind === 'refused') mutationError = o.message;
	});
	let chosen = $state<string | null>(null);
	const runNow = Effect.fn('Runs.runNow')(function* (automation: string) {
		mutationError = null;
		const o = yield* bolt.start(automation, {});
		if (o.kind === 'refused') mutationError = o.message;
	});
	const acts = (r: Pick<RunView, 'id' | 'status'>): Act[] => [
		...(stoppable(r.status) ? [{ label: t('Stop'), run: () => fork(stop(r.id)) }] : []),
		...(retryable(r.status) ? [{ label: t('Retry'), run: () => fork(retry(r.id)) }] : [])
	];
	const when = (v: string | null | undefined) =>
		v ? new Date(v).toLocaleString(bolt.locale) : '—';
	const warnings = (r: RunView): string[] =>
		EffectArray.isArray(r.attempts)
			? r.attempts.flatMap((attempt) => {
					const values = Predicate.isObject(attempt) ? attempt['warnings'] : undefined;
					return EffectArray.isArray(values)
						? values.filter((value): value is string => typeof value === 'string')
						: [];
				})
			: [];
</script>

{#snippet status({ row }: { row: RunRow; value: unknown })}
	<span class="flex min-w-0 items-center gap-2" data-status={row.status}>
		<span
			class={row.status === 'failed'
				? 'text-destructive'
				: row.status === 'running'
					? 'text-foreground'
					: 'text-muted-foreground'}>{t(row.status)}</span
		>
		{#if row.status === 'running' && typeof row.progress === 'number'}<progress
				class="h-1 w-16"
				max="1"
				value={row.progress}
			></progress>{/if}
		{#if row.error_code}<span class="truncate text-xs text-destructive">{row.error_code}</span>{/if}
	</span>
{/snippet}
{#snippet at({ value }: { row: RunRow; value: unknown })}<time class="tabular-nums"
		>{when(typeof value === 'string' ? value : null)}</time
	>{/snippet}
{#snippet actions({ row }: { row: RunRow; value: unknown })}<Acts acts={acts(row)} />{/snippet}

<SystemPage
	name="settings-automations"
	title={t('Automations')}
	icon="lucide:play"
	banner={automationsBanner}
	description={t(
		'Every automation run, newest first. Run one now, stop a queued or running run, or retry a failed one.'
	)}
	{error}
>
	{#if startable.length > 0}
		<div class="mb-3 flex flex-wrap items-center gap-2" data-run-now>
			<Combobox
				class="w-72"
				options={startable.map((a) => ({
					value: a.name,
					label: a.name,
					description: a.description
				}))}
				value={chosen}
				placeholder={t('Choose an automation')}
				onChange={(next) => (chosen = next)}
			/>
			<Button
				size="sm"
				disabled={chosen === null}
				onclick={() => chosen !== null && fork(runNow(chosen))}>{t('Run now')}</Button
			>
		</div>
	{/if}
	{#if rows === null}
		<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
	{:else}
		<Table
			of={rows}
			key="runs"
			onOpen={(r) => onRun(r.id)}
			toolbar={{ export: true }}
			columns={[
				{ field: 'automation', label: t('Automation') },
				{ field: 'status', label: t('Status'), cell: status },
				{ field: 'cause', label: t('Cause') },
				{ field: 'due_at', label: t('Due'), cell: at },
				{ field: 'started', label: t('Started'), cell: at },
				{ field: 'attempt_count', label: t('Attempts') },
				{ field: 'id', label: t('Actions'), hide: 'narrow', cell: actions }
			]}
		>
			{#snippet empty()}
				<EmptyState
					variant="inset"
					icon="play"
					title={t('No runs yet.')}
					hint={t('Automation runs appear here.')}
				/>
			{/snippet}
		</Table>
	{/if}
</SystemPage>

{#if run !== null && one !== null}
	{@const w = warnings(one)}
	{@const input = kinds.automations?.[one.automation]?.input}
	<DetailSheet
		title={`${one.automation} · ${t(one.status)}`}
		acts={acts(one)}
		onClose={() => onRun(null)}
		fields={[
			{ label: t('Cause'), value: one.cause },
			{ label: t('Status'), value: t(one.status) },
			{ label: t('Due'), value: when(one.due_at) },
			{ label: t('Started'), value: when(one.started) },
			{ label: t('Attempts'), value: one.attempt_count },
			{
				label: t('Error'),
				value:
					one.error === null
						? undefined
						: `${one.error.code}${one.error.message ? `: ${one.error.message}` : ''}`
			},
			{ label: t('Warnings'), value: w.length === 0 ? undefined : w.join('\n') },
			{ label: t('Progress'), value: one.progress ?? undefined },
			{
				label: t('Input'),
				value: one.input,
				kind: input === undefined ? { kind: 'json' } : { kind: 'object', fields: input }
			},
			{ label: t('Result'), value: one.result, kind: { kind: 'json' } }
		]}
	>
		{#snippet summary()}
			{#if one?.files?.length}
				<div class="grid gap-2" data-run-output-files>
					<p class="text-meta">{t('Files')}</p>
					<Show
						kind={{ kind: 'file', accept: ['*/*'], max: '20MiB', multiple: true }}
						value={one.files}
						readonly
					/>
				</div>
			{/if}
		{/snippet}
	</DetailSheet>
{/if}
