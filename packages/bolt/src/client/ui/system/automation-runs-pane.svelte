<script lang="ts">
	import { Effect, Schema } from 'effect';
	import { onMount } from 'svelte';
	import { getErrorMessage } from '@norbital-ai/std';
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { FEATURE_COLOR_STYLES } from '@norbital-ai/ui/feature-colors';
	import { Bound, Cover, Inline, Stack } from '@norbital-ai/ui/layout';
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
	let actionFailure = $state<string | undefined>();
	const styles = $derived(FEATURE_COLOR_STYLES.automations);
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

	const run = (): Effect.Effect<void> => {
		if (execution === undefined) {
			return Effect.sync(() => {
				actionFailure = t('bolt.automations.clientUnavailable');
			});
		}
		return Effect.tryPromise({
			try: () => execution.run({}),
			catch: (cause) => cause
		}).pipe(
			Effect.match({
				onFailure: (cause) => {
					actionFailure = getErrorMessage(cause);
				},
				onSuccess: () => {
					actionFailure = undefined;
				}
			})
		);
	};

	/** Stops one run, from its own row. A run is the thing that stops, not the automation. */
	const stop = (taskId: string): Effect.Effect<void> => {
		if (execution === undefined) return Effect.void;
		return Effect.tryPromise(() => execution.stop(taskId)).pipe(
			Effect.match({
				onFailure: (cause) => {
					actionFailure = getErrorMessage(cause);
				},
				onSuccess: () => {
					actionFailure = undefined;
				}
			})
		);
	};

	onMount(() => {
		browserReady = true;
	});
</script>

<Cover gap="none" class="bg-background">
	{#snippet top()}
		<Stack gap="md" class="border-b border-border/60 px-4 py-4 sm:px-6 sm:py-6">
			<Inline justify="between" align="start" gap="md">
				<Stack gap="xs" class="min-w-0">
					<h1 class="text-heading">{t('bolt.automations.title')}</h1>
					<p class="max-w-2xl text-meta">
						{t('bolt.automations.description')}
					</p>
				</Stack>

				{#if automations.length > 0}
					<Combobox
						{options}
						value={automation?.name ?? null}
						onValueChange={(next) => {
							if (next !== null) onselect?.(next);
						}}
						ariaLabel={t('bolt.automations.selector')}
						searchPlaceholder={t('bolt.automations.search')}
						preserveOptionOrder
						class="w-72 shrink-0"
					>
						{#snippet display(name)}
							{@const trigger = automations.find((candidate) => candidate.name === name)?.trigger}
							<Inline as="span" gap="xs" class="min-w-0">
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
				{/if}
			</Inline>

			{#if automation !== undefined}
				<Inline align="start" gap="sm">
					<div
						class="flex size-7 shrink-0 items-center justify-center rounded-md border {styles.iconWrapperClass}"
					>
						<ProductIcon name="automations" class="size-4 {styles.iconClass}" />
					</div>
					<Stack gap="xs" grow class="min-w-0">
						<p class="font-mono text-xs font-semibold text-foreground">{automation.name}</p>
						{#if automation.description !== undefined}
							<p class="max-w-3xl text-meta">{automation.description}</p>
						{/if}
						{#if activeQuery?.error !== undefined}
							<p class="text-micro text-destructive" role="alert">
								{t('bolt.automations.statusUnavailable', {
									error: getErrorMessage(activeQuery.error)
								})}
							</p>
						{:else if actionFailure !== undefined}
							<p class="text-micro text-destructive" role="alert">
								{t('bolt.automations.actionFailed', { error: actionFailure })}
							</p>
						{/if}
					</Stack>
					{#if canShowAutomationSource({ canEnterStudio, sourcePath: automation.sourcePath })}
						<button
							type="button"
							class="shrink-0 text-micro text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label={t('bolt.studio.openEntitySource', { entity: automation.name })}
							title={automation.sourcePath}
							onclick={() => {
								const path = automation.sourcePath;
								if (path !== undefined) studioSource().openSource(path);
							}}
						>
							<Inline as="span" gap="xs">
								<Icon icon="lucide:arrow-right-circle" class="size-3" />
								{t('bolt.studio.source')}
							</Inline>
						</button>
					{/if}
					<Button
						size="sm"
						disabled={execution === undefined || running}
						onclick={() => void Effect.runPromise(run())}
					>
						<Icon icon="lucide:play" class="size-3.5" />
						{t(
							latestManual?.status === 'failed'
								? 'bolt.automations.retry'
								: 'bolt.automations.runNow'
						)}
					</Button>
				</Inline>
			{/if}
		</Stack>
	{/snippet}

	<Bound size="full" grow clip class="px-4 py-4 sm:px-6">
		{#if automation === undefined}
			<Stack fill align="center" justify="center" gap="sm" class="text-muted-foreground">
				<ProductIcon name="automations" class="size-8 opacity-30" />
				<p class="text-xs">{t('bolt.automations.none')}</p>
			</Stack>
		{:else}
			<CollectionTable
				{client}
				collection="automation_run"
				view={`automations:runs:${automation.name}`}
				title={t('bolt.automations.runHistory', { name: automation.name })}
				description={t('bolt.automations.runHistoryDescription')}
				features={{ create: false, search: false }}
				query={{
					where: { name: { eq: automation.name } },
					orderBy: { created_at: 'desc' }
				}}
				class="min-h-0"
			>
				{#snippet columns({ Column })}
					<Column name="name" label={t('bolt.automations.column.automation')} card="title" />
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
						card="subtitle"
						renderer={AutomationProgressRenderer}
					/>
					<Column name="progress_updated_at" label={t('bolt.automations.column.updated')} />
					<Column name="error" label={t('bolt.automations.column.error')} />
				{/snippet}
			</CollectionTable>
		{/if}
	</Bound>
</Cover>
