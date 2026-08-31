<script lang="ts">
	import { Effect, Schema } from 'effect';
	import { onMount } from 'svelte';
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { FormattedValueRenderer } from '@norbital-ai/ui/data-renderer';
	import { FEATURE_COLOR_STYLES } from '@norbital-ai/ui/feature-colors';
	import { Bound, Cover, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import AutomationProgressRenderer from './automation-progress.renderer.svelte';
	import { presentAutomationStatus, type AutomationRunStatus } from './automation-presentation.js';
	import type { WorkspaceClient } from './workspace-client.js';
	import type { WorkspaceManifest } from './studio-state.js';

	let {
		client,
		automations = [],
		selected,
		onselect
	}: {
		client: WorkspaceClient;
		automations?: WorkspaceManifest['automations'];
		selected?: string | undefined;
		onselect?: ((name: string) => void) | undefined;
	} = $props();

	let browserReady = $state(false);
	let actionFailure = $state<string | undefined>();
	const styles = $derived(FEATURE_COLOR_STYLES.automations);
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
	const activeTaskId = $derived(
		activeRun?.task_id ??
			(latestManual !== undefined && latestManualStatus.canStop ? execution?.latest?.id : undefined)
	);
	const running = $derived(activeTaskId !== undefined || (execution?.pending ?? 0) > 0);

	const AutomationRunStatusValue = Schema.Literals(['pending', 'running', 'done', 'failed']);
	const automationRunStatus = (value: unknown): AutomationRunStatus | undefined =>
		Schema.is(AutomationRunStatusValue)(value) ? value : undefined;
	const formatAutomationStatus = ({ value }: { value: unknown }): string =>
		presentAutomationStatus(automationRunStatus(value)).label;

	const run = (): Effect.Effect<void> => {
		if (execution === undefined) {
			return Effect.sync(() => {
				actionFailure = 'The workspace automation client is unavailable.';
			});
		}
		return Effect.tryPromise({
			try: () => execution.run({}),
			catch: (cause) => cause
		}).pipe(
			Effect.match({
				onFailure: (cause) => {
					actionFailure = cause instanceof Error ? cause.message : String(cause);
				},
				onSuccess: () => {
					actionFailure = undefined;
				}
			})
		);
	};

	const stop = (): Effect.Effect<void> => {
		if (execution === undefined || activeTaskId === undefined) return Effect.void;
		return Effect.tryPromise(() => execution.stop(activeTaskId)).pipe(
			Effect.match({
				onFailure: (cause) => {
					actionFailure = cause instanceof Error ? cause.message : String(cause);
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
		<Stack gap="md" class="border-b border-border/60 px-4 py-4 sm:px-6">
			<Stack gap="xs">
				<h2 class="text-sm font-semibold text-foreground">Automation runs</h2>
				<p class="max-w-2xl text-meta">
					Trigger declared automations and inspect every scheduled or manual run.
				</p>
			</Stack>

			{#if automations.length > 0}
				<Scroll axis="x" name="Automation selector" layout="inline" gap="xs" fade={false}>
					{#each automations as candidate (candidate.name)}
						<Button
							size="sm"
							variant={candidate.name === automation?.name ? 'secondary' : 'ghost'}
							onclick={() => onselect?.(candidate.name)}
						>
							{candidate.name}
						</Button>
					{/each}
				</Scroll>
			{/if}

			{#if automation !== undefined}
				<Inline align="start" gap="sm">
					<div
						class={cn(
							'flex size-7 shrink-0 items-center justify-center rounded-md border',
							styles.iconWrapperClass
						)}
					>
						<ProductIcon name="automations" class={cn('size-4', styles.iconClass)} />
					</div>
					<Stack gap="xs" grow class="min-w-0">
						<p class="font-mono text-xs font-semibold text-foreground">{automation.name}</p>
						<p class="max-w-3xl text-meta">
							{automation.description ?? 'No description declared.'}
						</p>
						{#if activeQuery?.error !== undefined}
							<p class="text-micro text-destructive" role="alert">
								Run status unavailable: {activeQuery.error instanceof Error
									? activeQuery.error.message
									: String(activeQuery.error)}
							</p>
						{:else if actionFailure !== undefined}
							<p class="text-micro text-destructive" role="alert">
								Automation action failed: {actionFailure}
							</p>
						{/if}
					</Stack>
					{#if running}
						<Button size="sm" variant="outline" onclick={() => void Effect.runPromise(stop())}>
							<Icon icon="lucide:square" class="size-3.5" />
							Stop run
						</Button>
					{:else}
						<Button
							size="sm"
							disabled={execution === undefined}
							onclick={() => void Effect.runPromise(run())}
						>
							<Icon icon="lucide:play" class="size-3.5" />
							{latestManual?.status === 'failed' ? 'Retry' : 'Run now'}
						</Button>
					{/if}
				</Inline>
			{/if}
		</Stack>
	{/snippet}

	<Bound size="full" grow clip class="px-4 py-4 sm:px-6">
		{#if automation === undefined}
			<Stack fill align="center" justify="center" gap="sm" class="text-muted-foreground">
				<ProductIcon name="automations" class="size-8 opacity-30" />
				<p class="text-xs">No automations declared</p>
			</Stack>
		{:else}
			<CollectionTable
				{client}
				collection="automation_run"
				view={`studio:automation-runs:${automation.name}`}
				title={`${automation.name} run history`}
				description="Scheduled and manual invocations, newest first."
				features={{ create: false, search: false }}
				query={{
					where: { name: { eq: automation.name } },
					orderBy: { created_at: 'desc' }
				}}
				class="min-h-0"
			>
				{#snippet columns({ Column })}
					<Column name="name" label="Automation" card="title" />
					<Column
						name="status"
						label="Status"
						card="badge"
						renderer={FormattedValueRenderer}
						rendererProps={{ format: formatAutomationStatus }}
					/>
					<Column
						name="progress"
						label="Progress"
						card="subtitle"
						renderer={AutomationProgressRenderer}
					/>
					<Column name="progress_updated_at" label="Updated" />
					<Column name="error" label="Error" />
				{/snippet}
			</CollectionTable>
		{/if}
	</Bound>
</Cover>
