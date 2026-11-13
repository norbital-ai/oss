<!--
	The command center's Automations: every run, newest first, with who or what triggered it, in ui's `Table` (search, filter and sort, CSV), the live
	`runs` read (a `sys_run` change re-answers it; only an open running run's log polls). A queued or running run has Stop; a failed or stopped one has Retry, a new run
	of its automation with the same input. Run now starts any automation the member may start that needs no input. Opening a row shows the run as `runs.view` redacts it (`?run=<id>`), read once again whenever that run's live row
	changes.
-->
<script lang="ts">
	import { watch } from 'runed';
	import { equal_json } from '@norbital-ai/store/kind';
	import { fork, observe } from '@norbital-ai/ui/effect';
	import { Effect, Stream } from 'effect';
	import {
		automation_outcome,
		Badge,
		Button,
		Combobox,
		Dialog,
		EmptyState,
		Form,
		Icon,
		Show,
		Table,
		type UiContext
	} from '@norbital-ai/ui';
	import { Cluster } from '@norbital-ai/ui/layout';
	import { LIMITS, type LogRow } from '../../engine/contracts.ts';
	import type { RunView } from '../../engine/runs/rows.ts';
	import type { Act } from '../Acts.svelte';
	import Acts from '../Acts.svelte';
	import DetailSheet from '../DetailSheet.svelte';
	import type { ShellBolt } from '../runtime.ts';
	import { RunsReadAnswer, type ShellApi } from '../api-types.ts';
	import { date_time } from '../i18n.ts';

	let {
		ctx,
		api,
		bolt,
		t,
		startable = [],
		run = null,
		on_run,
		initial_automation = null,
		on_automation_close
	}: {
		ctx: UiContext;
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		startable?: readonly {
			readonly name: string;
			readonly description: string;
			readonly needs_input?: boolean;
		}[];
		run?: string | null;
		on_run: (id: string | null) => void;
		initial_automation?: string | null;
		on_automation_close?: () => void;
	} = $props();

	const runs = observe(() =>
		bolt.observe({ read: { m: 'runs', a: [{ limit: 500, brief: true }] } }, RunsReadAnswer)
	);
	// Run metadata follows the live row. Its external log store supplies only newly appended lines between row changes.
	const detail = observe(() => {
		if (run === null) return null;
		const id = run;
		return bolt
			.observe({ read: { m: 'runs', a: [{ id, limit: 1, brief: true }] } }, RunsReadAnswer)
			.pipe(
				Stream.changesWith((a, b) => equal_json(a.rows, b.rows)),
				Stream.switchMap((answer) =>
					Stream.fromEffect(api.run(id)).pipe(Stream.flatMap((detail) => {
						const access = detail.log_access;
						if (!answer.rows.some((row) => row.status === 'running') || detail.logs === undefined || access === undefined)
							return Stream.succeed(detail);
						let lines = typeof detail.logs === 'string' ? [] : detail.logs;
						let after = lines.at(-1)?.id;
						const tail = Stream.tick(LIMITS.runLog.pollMs).pipe(
							Stream.drop(1),
							Stream.mapEffect(() => api.run_log(id, access, after).pipe(Effect.map((appended) => {
								if (typeof appended === 'string') return { ...detail, logs: appended };
								after = appended.at(-1)?.id ?? after;
								lines = [...lines, ...appended].slice(-LIMITS.runLog.lines);
								return { ...detail, logs: lines };
							})))
						);
						return Stream.succeed(detail).pipe(Stream.concat(tail));
					}))
				)
			);
	});
	// who or what started a run: a person (and Norbius when it started it for them), else the system and why
	const triggerOf = (trigger: RunView['trigger']) =>
		trigger === null
			? '—'
			: trigger.kind === 'person'
				? `${trigger.name ?? trigger.ref}${trigger.agent ? ` · ${t('via Norbius')}` : ''}`
				: `${t('System')} · ${
						trigger.cause === 'effect' || trigger.cause === 'event'
							? `${trigger.model}.${trigger.verb}`
							: trigger.cause === 'schedule'
								? (trigger.by?.automation ?? t('schedule'))
								: trigger.cause
					}`;
	// the queue holds every run: an authored automation (a source handle never holds a dot), a model's effect or sync
	// (`<model>.effect.<verb>`, `<model>.sync.<sync>`), else platform work named by its area (`bolt.notify`, `agent.turn`)
	const named = (automation: string) => {
		const scoped = /^([^.]+)\.(effect|sync)\.(.+)$/.exec(automation);
		if (scoped !== null) return { namespace: scoped[2] ?? '', name: `${scoped[1]}.${scoped[3]}` };
		const dot = automation.indexOf('.');
		return dot === -1
			? { namespace: 'automation', name: automation }
			: { namespace: automation.slice(0, dot), name: automation.slice(dot + 1) };
	};
	const NAMESPACE_ICONS: Readonly<Record<string, string>> = {
		automation: 'lucide:workflow',
		effect: 'lucide:git-commit-horizontal',
		sync: 'lucide:refresh-cw',
		bolt: 'lucide:zap',
		agent: 'lucide:sparkles',
		envoys: 'lucide:send',
		notifications: 'lucide:bell',
		integrations: 'lucide:plug',
		link: 'lucide:link'
	};
	const runRow = (r: RunView) => {
		const { namespace, name } = named(r.automation);
		return {
			id: r.id,
			namespace,
			name,
			trigger: triggerOf(r.trigger),
			cause: r.cause,
			status: r.status,
			due_at: r.due_at,
			started: r.started,
			progress: r.progress,
			error_code: r.error?.code ?? null,
			attempt_count: r.attempt_count
		};
	};
	type RunRow = ReturnType<typeof runRow>;
	const rows = $derived(runs.current?.rows.map(runRow) ?? null);
	const one = $derived($detail ?? null);
	let mutationError = $state<string | null>(null);
	const error = $derived(mutationError ?? runs.error?.message ?? detail.error?.message ?? null);

	const stoppable = (status: string) => status === 'queued' || status === 'running';
	const retryable = (status: string) => status === 'failed' || status === 'stopped';
	const stop = Effect.fn('Runs.stop')(function* (id: string) {
		mutationError = null;
		const r = yield* Effect.result(api.stop_run(id));
		if (r._tag === 'Failure') mutationError = r.failure.message;
	});
	const retry = Effect.fn('Runs.retry')(function* (id: string) {
		mutationError = null;
		const r = yield* Effect.result(api.run(id));
		if (r._tag === 'Failure') return void (mutationError = r.failure.message);
		const o = yield* Effect.result(automation_outcome(bolt.run(r.success.automation, r.success.input ?? {})));
		if (o._tag === 'Failure') mutationError = o.failure.message;
		else if (o.success.kind === 'refused') mutationError = o.success.message;
	});
	let chosen = $state<string | null>(null);
	/** The automation whose native input form is open (one that needs a required input). */
	let entering = $state<string | null>(null);
	function closeAutomation(): void {
		entering = null;
		on_automation_close?.();
	}
	watch(
		() => initial_automation,
		(name) => {
			if (name !== null && startable.some((item) => item.name === name)) entering = name;
		}
	);
	const runNow = Effect.fn('Runs.runNow')(function* (automation: string) {
		mutationError = null;
		if (startable.find((a) => a.name === automation)?.needs_input === true) {
			entering = automation;
			return;
		}
		const o = yield* Effect.result(automation_outcome(bolt.run(automation, {})));
		if (o._tag === 'Failure') mutationError = o.failure.message;
		else if (o.success.kind === 'refused') mutationError = o.success.message;
	});
	const acts = (r: Pick<RunView, 'id' | 'status'>): Act[] => [
		...(stoppable(r.status) ? [{ label: t('Stop'), run: () => fork(stop(r.id)) }] : []),
		...(retryable(r.status) ? [{ label: t('Retry'), run: () => fork(retry(r.id)) }] : [])
	];
	/** What a log line says: a console line's own text, else its event's name. */
	const lineOf = (row: LogRow) =>
		typeof row.attributes === 'object' &&
		row.attributes !== null &&
		'line' in row.attributes &&
		typeof row.attributes.line === 'string'
			? row.attributes.line
			: row.event;
	const when = (v: string | null | undefined) =>
		v ? date_time(v, bolt.locale) : '—';
	const warnings = (r: RunView) => (r.attempts ?? []).flatMap((attempt) => attempt.warnings ?? []);
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
{#snippet namespace({ row }: { row: RunRow; value: unknown })}
	<Badge
		variant={row.namespace === 'automation' ? 'brand' : 'outline'}
		class="gap-1"
		data-namespace={row.namespace}
		><Icon
			name={NAMESPACE_ICONS[row.namespace] ?? 'lucide:box'}
			class="size-3"
		/>{row.namespace}</Badge
	>
{/snippet}
{#snippet at({ value }: { row: RunRow; value: unknown })}<time class="tabular-nums"
		>{when(typeof value === 'string' ? value : null)}</time
	>{/snippet}
{#snippet actions({ row }: { row: RunRow; value: unknown })}<Acts acts={acts(row)} />{/snippet}

{#snippet runNowControls()}
	<Cluster gap="xs" data-run-now>
		<Combobox
			class="w-56"
			options={startable.map((a) => ({
				value: a.name,
				label: a.name,
				description: a.description
			}))}
			value={chosen}
			placeholder={t('Choose an automation')}
			on_change={(next) => (chosen = next)}
		/>
		<Button disabled={chosen === null} onclick={() => chosen !== null && fork(runNow(chosen))}
			>{t('Run now')}</Button
		>
	</Cluster>
{/snippet}

<div class="flex flex-col gap-3">
	{#if error !== null}<p
			role="alert"
			class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{error}
		</p>{/if}
	{#if rows === null}
		<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
	{:else}
		<Table {ctx}
			of={rows}
			key="runs"
			on_open={(r) => on_run(r.id)}
			toolbar={{ export: true, ...(startable.length > 0 ? { trailing: runNowControls } : {}) }}
			columns={[
				{ field: 'namespace', label: t('Namespace'), cell: namespace },
				{ field: 'name', label: t('Name') },
				{ field: 'status', label: t('Status'), cell: status },
				{ field: 'trigger', label: t('Triggered by') },
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
</div>

{#if run !== null && one !== null}
	{@const w = warnings(one)}
	{@const input = bolt.automations?.[one.automation]?.input}
	<DetailSheet {ctx}
		title={`${one.automation} · ${t(one.status)}`}
		acts={acts(one)}
		on_close={() => on_run(null)}
		fields={[
			{ label: t('Triggered by'), value: triggerOf(one.trigger) },
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
					<Show {ctx}
						kind={{ kind: 'file', accept: ['*/*'], max: '1024GiB', many: true }}
						value={one.files}
						readonly
					/>
				</div>
			{/if}
		{/snippet}
		{#if one.logs !== undefined}
			<div class="grid gap-2" data-run-logs>
				<p class="text-meta">{t('Logs')}</p>
				{#if typeof one.logs === 'string'}
					<p class="text-meta text-destructive">{one.logs}</p>
				{:else if one.logs.length === 0}
					<p class="text-meta">{t('No log lines')}</p>
				{:else}
					<ol class="max-h-72 overflow-auto rounded-md border p-2 font-mono text-micro">
						{#each one.logs as row (row.id)}
							<li class="whitespace-pre-wrap" data-severity={row.severity}>
								<span class="text-muted-foreground">{when(row.at)}</span>
								<span class={row.severity === 'info' ? '' : 'text-destructive'}>{lineOf(row)}</span>
							</li>
						{/each}
					</ol>
				{/if}
			</div>
		{/if}
	</DetailSheet>
{/if}

{#if entering !== null}
	<Dialog.Root
		open
		on_open_change={(next) => {
			if (!next) closeAutomation();
		}}
	>
		<Dialog.Content class="max-w-xl" data-run-automation-form>
			<Dialog.Header>
				<Dialog.Title>{t('Run')} {entering}</Dialog.Title>
				<Dialog.Description
					>{t('Fill in this automation’s input before it runs.')}</Dialog.Description
				>
			</Dialog.Header>
			<Form {ctx} of={{ automation: entering }} submit={t('Run')} on_outcome={closeAutomation} />
		</Dialog.Content>
	</Dialog.Root>
{/if}
