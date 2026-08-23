<script lang="ts" generics="TRow extends object">
	import Icon from '@iconify/svelte';
	import { Effect, Schema } from 'effect';
	import * as Accordion from '#lib/accordion';
	import { Button, buttonVariants } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { toast } from 'svelte-sonner';
	import type {
		CollectionTableIntegrationStatus,
		CollectionTablePipeline,
		CollectionTablePipelineContext
	} from '#lib/collection-table/collection-table.types';
	import CollectionTableIntegrationsPanel from './collection-table-integrations-panel.svelte';
	import CollectionTablePipelinePanel from './collection-table-pipeline-panel.svelte';

	const OperationKindSchema = Schema.Literals(['export', 'import']);
	type OperationKind = typeof OperationKindSchema.Type;

	let {
		collectionName,
		exportPipelines,
		importPipelines,
		integrations,
		selectedRows,
		selectionControls,
		disabled
	}: {
		collectionName: string;
		exportPipelines: readonly CollectionTablePipeline<TRow>[];
		importPipelines: readonly CollectionTablePipeline<TRow>[];
		integrations: readonly CollectionTableIntegrationStatus[];
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
	let expandedSections = $state<string[]>(['export']);
	let actionsOpen = $state(false);
	const menuAvailable = $derived(
		exportPipelines.length > 0 || importPipelines.length > 0 || integrations.length > 0
	);

	function runPipeline(kind: OperationKind, pipeline: CollectionTablePipeline<TRow>): void {
		const operationKey = `${kind}:${pipeline.id}`;
		if (
			pendingOperation ||
			disabled ||
			(pipeline.requiresSelection && selectedRows.length === 0) ||
			pipeline.getDisabledReason?.(selectedRows)
		)
			return;
		pendingOperation = operationKey;
		const context: CollectionTablePipelineContext<TRow> = {
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
</script>

{#snippet pipelinePanel(kind: OperationKind)}
	<CollectionTablePipelinePanel
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
	<Accordion.Root type="multiple" bind:value={expandedSections} class="p-2">
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
					<CollectionTableIntegrationsPanel {integrations} />
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
				class="max-h-[min(75dvh,42rem)] w-[min(34rem,calc(100vw-1rem))] overflow-y-auto p-0"
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
