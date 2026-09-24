<script lang="ts">
	import { Effect } from 'effect';
	import { onMount } from 'svelte';
	import { getErrorMessage } from '@norbital-ai/std';
	import Icon from '@iconify/svelte';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import type { CollectionPipeline } from '@norbital-ai/ui/collection-surface';
	import { Bound, Inline, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import AutomationProgressRenderer from './automation-progress.renderer.svelte';
	import AutomationStatusRenderer from './automation-status.renderer.svelte';
	import {
		canShowAutomationSource,
		presentAutomationStatus,
		useStudioSourceEntitlement
	} from './automation-presentation.js';
	import type { AutomationRunsClient } from '../studio/workspace-client.js';
	import type { WorkspaceManifest } from '../studio/studio-state.js';

	let {
		client,
		automations = [],
		selected,
		onselect
	}: {
		client: AutomationRunsClient;
		automations?: WorkspaceManifest['automations'];
		selected?: string | undefined;
		onselect?: ((name: string) => void) | undefined;
	} = $props();
	const { t } = useI18n();
	const studioSource = useStudioSourceEntitlement();
	const canEnterStudio = $derived(studioSource().canEnterStudio);

	let browserReady = $state(false);
	/** A row's Stop is outside the operations menu, so its refusal is stated above the table. */
	let stopFailure = $state<string | undefined>();
	type Trigger = WorkspaceManifest['automations'][number]['trigger'];
	const TRIGGER_ICONS = {
		Schedule: 'lucide:repeat',
		Change: 'lucide:webhook',
		Manual: 'lucide:hand'
	} satisfies Record<Trigger['_tag'], string>;
	const triggerDetail = (trigger: Trigger): { description?: string } =>
		trigger._tag === 'Schedule'
			? { description: trigger.cron }
			: trigger._tag === 'Change'
				? {
						description: t('bolt.automations.trigger.change', {
							collection: trigger.collection,
							event: trigger.event
						})
					}
				: {};
	const options = $derived(
		automations.map((candidate) => ({
			value: candidate.name,
			label: candidate.name,
			icon: TRIGGER_ICONS[candidate.trigger._tag],
			type: t(`bolt.automations.trigger.${candidate.trigger._tag}`),
			...triggerDetail(candidate.trigger)
		}))
	);
	const automation = $derived(
		automations.find((candidate) => candidate.name === selected) ?? automations[0]
	);
	const execution = $derived(
		automation === undefined ? undefined : client.automations[automation.name]
	);
	const activeQuery = $derived(
		browserReady && automation !== undefined
			? client.db.automation_run.findMany({
					where: {
						name: { eq: automation.name },
						status: { in: ['pending', 'running'] }
					},
					orderBy: { created_at: 'desc' },
					limit: 1
				})
			: undefined
	);
	const activeRun = $derived(activeQuery?.current?.[0]);
	const latestManual = $derived(execution?.latest?.current);
	const latestManualStatus = $derived(presentAutomationStatus(latestManual?.status));
	const activeConversationId = $derived(
		activeRun?.task_id ??
			(latestManual !== undefined && latestManualStatus.canStop ? execution?.latest?.id : undefined)
	);
	const running = $derived(activeConversationId !== undefined || (execution?.pending ?? 0) > 0);

	/**
	 * The automation's own operations live in the table's operations menu, not in page chrome:
	 * running it and opening its source. A failed run surfaces as the menu's toast.
	 */
	const operations = $derived.by((): CollectionPipeline<Record<string, unknown>>[] => {
		if (automation === undefined) return [];
		const { name, sourcePath } = automation;
		const runNow: CollectionPipeline<Record<string, unknown>> = {
			id: 'run',
			label: t(
				latestManual?.status === 'failed' ? 'bolt.automations.retry' : 'bolt.automations.runNow'
			),
			icon: 'lucide:play',
			getDisabledReason: () =>
				execution === undefined
					? t('bolt.automations.clientUnavailable')
					: activeQuery?.error !== undefined
						? t('bolt.automations.statusUnavailable', {
								error: getErrorMessage(activeQuery.error)
							})
						: running
							? t('bolt.automations.status.running')
							: null,
			run: () =>
				execution === undefined
					? Effect.void
					: Effect.tryPromise({
							try: () => execution.run({}),
							catch: (cause) => new Error(getErrorMessage(cause))
						})
		};
		const source: CollectionPipeline<Record<string, unknown>> = {
			id: 'source',
			label: t('bolt.studio.source'),
			...(sourcePath === undefined ? {} : { description: sourcePath }),
			icon: 'lucide:arrow-right-circle',
			run: () =>
				Effect.sync(() => {
					if (sourcePath !== undefined) studioSource().openSource(sourcePath);
				})
		};
		return canShowAutomationSource({ canEnterStudio, sourcePath: automation.sourcePath })
			? [runNow, source]
			: [runNow];
	});

	/** Stops one run, from its own row. A run is the thing that stops, not the automation. */
	const stop = (taskId: string): Effect.Effect<void> => {
		if (execution === undefined) return Effect.void;
		return Effect.tryPromise(() => execution.stop(taskId)).pipe(
			Effect.match({
				onFailure: (cause) => {
					stopFailure = getErrorMessage(cause);
				},
				onSuccess: () => {
					stopFailure = undefined;
				}
			})
		);
	};

	onMount(() => {
		browserReady = true;
	});
</script>

{#snippet selector()}
	<Combobox
		{options}
		value={automation?.name ?? null}
		onValueChange={(next) => {
			if (next !== null) onselect?.(next);
		}}
		ariaLabel={t('bolt.automations.selector')}
		searchPlaceholder={t('bolt.automations.search')}
		preserveOptionOrder
		class="w-72"
	>
		{#snippet display(name)}
			{@const trigger = automations.find((candidate) => candidate.name === name)?.trigger}
			<Inline as="span" gap="xs">
				{#if trigger !== undefined}
					<Icon
						icon={TRIGGER_ICONS[trigger._tag]}
						class="size-3.5 shrink-0 text-muted-foreground"
					/>
				{/if}
				<span class="truncate">{name}</span>
			</Inline>
		{/snippet}
	</Combobox>
{/snippet}

<!-- The page is the run table: scope in its navigation, operations in its menu, prose behind ⓘ. -->
<Bound size="full" inset>
	{#if automation === undefined}
		<Stack fill align="center" justify="center" gap="sm" class="text-muted-foreground">
			<ProductIcon name="automations" class="size-8 opacity-30" />
			<p class="text-xs">{t('bolt.automations.none')}</p>
		</Stack>
	{:else}
		<Stack gap="sm" fill>
			{#if stopFailure !== undefined}
				<p class="text-micro text-destructive" role="alert">
					{t('bolt.automations.actionFailed', { error: stopFailure })}
				</p>
			{/if}
			<CollectionTable
				{client}
				collection="automation_run"
				view={`automations:runs:${automation.name}`}
				title={t('bolt.automations.runHistory', { name: automation.name })}
				description={automation.description ?? t('bolt.automations.runHistoryDescription')}
				navigation={selector}
				bulkPipelines={operations}
				features={{ create: false, search: false }}
				query={{
					where: { name: { eq: automation.name } },
					orderBy: { created_at: 'desc' }
				}}
			>
				{#snippet columns({ Column })}
					<Column
						name="status"
						label={t('bolt.automations.column.status')}
						card="badge"
						renderer={AutomationStatusRenderer}
						rendererProps={{ onStop: (taskId: string) => void Effect.runPromise(stop(taskId)) }}
					/>
					<Column
						name="progress"
						label={t('bolt.automations.column.progress')}
						card="title"
						renderer={AutomationProgressRenderer}
					/>
					<Column
						name="progress_updated_at"
						label={t('bolt.automations.column.updated')}
						card="subtitle"
					/>
					<Column name="error" label={t('bolt.automations.column.error')} />
				{/snippet}
			</CollectionTable>
		</Stack>
	{/if}
</Bound>
