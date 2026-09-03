<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import { Effect, Schema } from 'effect';
	import * as Accordion from '#lib/accordion';
	import { Button, buttonVariants } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline, SCROLL_AXIS_CLASSES, Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { cn } from '#lib/utils';
	import { toast } from 'svelte-sonner';
	import type {
		CollectionIntegrationStatus,
		CollectionPipeline,
		CollectionPipelineContext,
		CollectionRecordDeletion
	} from '#lib/collection-surface';
	import { collectionOperationsAvailable } from './collection-operations-available.js';
	import CollectionToolbarIntegrationsPanel from './collection-toolbar-integrations-panel.svelte';
	import CollectionToolbarPipelinePanel from './collection-toolbar-pipeline-panel.svelte';

	const OperationKindSchema = Schema.Literals(['export', 'import']);
	type OperationKind = typeof OperationKindSchema.Type;

	let {
		collectionName,
		exportPipelines,
		importPipelines,
		integrations,
		deletion,
		selectedRows,
		selectionControls,
		disabled
	}: {
		collectionName: string;
		exportPipelines: readonly CollectionPipeline<TRow>[];
		importPipelines: readonly CollectionPipeline<TRow>[];
		integrations: readonly CollectionIntegrationStatus[];
		deletion?: CollectionRecordDeletion<TRow>;
		selectedRows: readonly TRow[];
		selectionControls?: {
			readonly totalRows: number;
			readonly allSelected: boolean;
			toggleAll(): void;
		};
		disabled: boolean;
	} = $props();

	const { t } = useI18n<UiKeys>();

	let pendingOperation = $state<string | null>(null);
	let expandedOverride = $state<string[] | undefined>(undefined);
	const expandedSections = $derived(
		expandedOverride ??
			(exportPipelines.length > 0 ? ['export'] : deletion != null ? ['delete'] : ['export'])
	);
	let actionsOpen = $state(false);
	let deleteArmed = $state(false);
	const menuAvailable = $derived(
		collectionOperationsAvailable({
			exportCount: exportPipelines.length,
			importCount: importPipelines.length,
			integrationCount: integrations.length,
			deletion: deletion != null
		})
	);
	const deletionLabel = $derived(deletion?.label ?? t('table.deleteRecords'));
	const deletionDisabledReason = $derived.by(() => {
		if (!deletion) return null;
		if (selectedRows.length === 0) return t('table.pipelineSelectRows', { label: deletionLabel });
		return deletion.getDisabledReason?.(selectedRows) ?? null;
	});

	function runPipeline(kind: OperationKind, pipeline: CollectionPipeline<TRow>): void {
		const { id: pipelineId } = pipeline;
		const operationKey = `${kind}:${pipelineId}`;
		if (
			pendingOperation ||
			disabled ||
			(pipeline.requiresSelection && selectedRows.length === 0) ||
			pipeline.getDisabledReason?.(selectedRows)
		)
			return;
		pendingOperation = operationKey;
		const context: CollectionPipelineContext<TRow> = {
			collectionName,
			selectedRows
		};
		Effect.runFork(
			pipeline.run(context).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						toast.error(
							error instanceof Error
								? error.message
								: t('table.pipelineFailed', { label: pipeline.label })
						);
					})
				),
				Effect.onExit(() =>
					Effect.sync(() => {
						pendingOperation = null;
					})
				)
			)
		);
	}

	function runDeletion(): void {
		const run = deletion?.run;
		if (!run || pendingOperation || disabled || deletionDisabledReason) return;
		if (!deleteArmed) {
			deleteArmed = true;
			return;
		}
		pendingOperation = 'delete';
		const context: CollectionPipelineContext<TRow> = {
			collectionName,
			selectedRows
		};
		const label = deletionLabel;
		Effect.runFork(
			run(context).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						toast.success(t('table.bulkDeleted', { label }));
						deleteArmed = false;
					})
				),
				Effect.catch((error) =>
					Effect.sync(() => {
						toast.error(
							error instanceof Error ? error.message : t('table.bulkFailed', { kind: 'delete' })
						);
					})
				),
				Effect.onExit(() =>
					Effect.sync(() => {
						pendingOperation = null;
					})
				)
			)
		);
	}
</script>

{#snippet pipelinePanel(kind: OperationKind)}
	<CollectionToolbarPipelinePanel
		{kind}
		pipelines={kind === 'import' ? importPipelines : exportPipelines}
		{selectedRows}
		{disabled}
		{pendingOperation}
		onRun={(pipeline) => void runPipeline(kind, pipeline)}
	/>
{/snippet}

{#snippet actionsMenu()}
	<Inline align="start" justify="between" gap="md" class="border-b px-4 py-3">
		<div class="min-w-0">
			<p class="text-sm font-semibold">{t('table.collectionActions')}</p>
			<p class="mt-0.5 text-meta">{t('table.collectionActionsDescription')}</p>
		</div>
	</Inline>
	<Accordion.Root
		type="multiple"
		value={expandedSections}
		onValueChange={(next) => {
			expandedOverride = Array.isArray(next) ? next : [next];
		}}
		class="p-2"
	>
		{#if importPipelines.length > 0}
			<Accordion.Item value="import">
				<Accordion.Trigger class="px-2 hover:no-underline">
					<Inline gap="md">
						<Icon icon="lucide:upload" class="size-4 shrink-0" />
						<span>{t('table.import')}</span>
						<span class="rounded-full bg-muted px-2 py-0.5 text-meta">
							{importPipelines.length}
						</span>
					</Inline>
				</Accordion.Trigger>
				<Accordion.Content class="px-1">{@render pipelinePanel('import')}</Accordion.Content>
			</Accordion.Item>
		{/if}
		{#if exportPipelines.length > 0}
			<Accordion.Item value="export">
				<Accordion.Trigger class="px-2 hover:no-underline">
					<Inline gap="md">
						<Icon icon="lucide:download" class="size-4 shrink-0" />
						<span>{t('table.export')}</span>
						<span class="rounded-full bg-muted px-2 py-0.5 text-meta">
							{exportPipelines.length}
						</span>
					</Inline>
				</Accordion.Trigger>
				<Accordion.Content class="px-1">{@render pipelinePanel('export')}</Accordion.Content>
			</Accordion.Item>
		{/if}
		{#if integrations.length > 0}
			<Accordion.Item value="integrations">
				<Accordion.Trigger class="px-2 hover:no-underline">
					<Inline gap="md">
						<Icon icon="lucide:plug-zap" class="size-4 shrink-0" />
						<span>{t('table.integrations')}</span>
						<span class="rounded-full bg-muted px-2 py-0.5 text-meta">
							{integrations.length}
						</span>
					</Inline>
				</Accordion.Trigger>
				<Accordion.Content class="px-1">
					<CollectionToolbarIntegrationsPanel {integrations} />
				</Accordion.Content>
			</Accordion.Item>
		{/if}
		{#if deletion}
			<Accordion.Item value="delete">
				<Accordion.Trigger class="px-2 hover:no-underline">
					<Inline gap="md">
						<Icon icon="lucide:trash-2" class="size-4 shrink-0" />
						<span>{t('table.deleteRecords')}</span>
					</Inline>
				</Accordion.Trigger>
				<Accordion.Content class="px-1">
					<section class="rounded-md border border-border bg-background p-3 shadow-xs">
						<Inline align="start" gap="md">
							<div
								class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
							>
								<Icon icon="lucide:trash-2" class="size-4" />
							</div>
							<div class="min-w-0 flex-1">
								<p class="text-sm font-medium">{deletionLabel}</p>
								<Stack gap="sm">
									<p class="text-xs leading-relaxed text-muted-foreground">
										{deletion.description ?? t('table.confirmDeleteDescription')}
									</p>
									<p class="text-xs leading-relaxed text-muted-foreground">
										{t('table.deleteSelectedLabel', { label: deletionLabel })}
									</p>
									{#if deletionDisabledReason}
										<p class="text-xs leading-relaxed text-muted-foreground">
											{deletionDisabledReason}
										</p>
									{:else if deleteArmed}
										<Stack gap="xs">
											<p class="text-sm font-medium">
												{t('table.confirmDeleteTitle', { label: deletionLabel })}
											</p>
											<p class="text-xs leading-relaxed text-muted-foreground">
												{t('table.confirmDeleteDescription')}
											</p>
										</Stack>
									{/if}
								</Stack>
							</div>
							<Button
								type="button"
								size="sm"
								variant="destructive"
								class="shrink-0"
								disabled={disabled || pendingOperation !== null || deletionDisabledReason != null}
								onclick={() => void runDeletion()}
							>
								<Icon
									icon={pendingOperation === 'delete' ? 'lucide:loader-circle' : 'lucide:trash-2'}
									class={cn('size-4', pendingOperation === 'delete' && 'animate-spin')}
								/>
								{deleteArmed
									? t('table.confirmDeleteTitle', { label: deletionLabel })
									: t('table.reviewDeletion')}
							</Button>
						</Inline>
					</section>
				</Accordion.Content>
			</Accordion.Item>
		{/if}
	</Accordion.Root>
{/snippet}

<Inline gap="xs" class="min-w-0">
	{#if menuAvailable}
		<Popover.Root bind:open={actionsOpen}>
			<Popover.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon' })}
				aria-label={t('table.openCollectionActions')}
				title={t('table.collectionActions')}
			>
				<Icon icon="lucide:zap" class="size-4" />
			</Popover.Trigger>
			<Popover.Content
				align="start"
				class={cn(
					'max-h-[min(75dvh,42rem)] w-[min(34rem,calc(100vw-1rem))] p-0',
					SCROLL_AXIS_CLASSES.y
				)}
			>
				{@render actionsMenu()}
			</Popover.Content>
		</Popover.Root>
	{/if}
	{#if selectionControls}
		<span class="text-meta tabular-nums">
			{t('common.selected', { count: selectedRows.length })}
		</span>
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="h-8"
			disabled={disabled || selectionControls.totalRows === 0}
			onclick={selectionControls.toggleAll}
		>
			{selectionControls.allSelected ? t('table.clearAll') : t('common.selectAll')}
		</Button>
	{/if}
</Inline>
