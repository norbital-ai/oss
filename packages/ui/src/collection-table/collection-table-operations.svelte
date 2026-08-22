<script lang="ts" generics="TRow extends object">
	import type { CollectionField } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { Effect, Schema } from 'effect';
	import { tick } from 'svelte';
	import * as Accordion from '#lib/accordion';
	import * as AlertDialog from '#lib/alert-dialog';
	import { Button, buttonVariants } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import { DataRenderer } from '#lib/data-renderer';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline, Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { toast } from 'svelte-sonner';
	import type {
		CollectionTableIntegrationStatus,
		CollectionTablePipeline,
		CollectionTablePipelineContext
	} from '#lib/collection-table/collection-table.types';
	import CollectionTableIntegrationsPanel from './collection-table-integrations-panel.svelte';
	import CollectionTablePipelinePanel from './collection-table-pipeline-panel.svelte';
	import { isSystemField } from './collection-card-derivation';

	const OperationKindSchema = Schema.Literals(['export', 'import']);
	const BulkOperationSchema = Schema.Literals(['update', 'delete']);
	type OperationKind = typeof OperationKindSchema.Type;
	type BulkOperation = typeof BulkOperationSchema.Type;
	const PRIMITIVE_FIELD_KINDS = new Set([
		'boolean',
		'clock_time',
		'date',
		'enum',
		'integer',
		'numeric',
		'number',
		'phone',
		'string',
		'text',
		'timestamp',
		'timestamptz',
		'datetime',
		'uuid'
	]);

	let {
		collectionName,
		exportPipelines,
		importPipelines,
		integrations,
		selectedRows,
		fields,
		updateSelected,
		deleteSelected,
		updateUnavailable,
		deleteUnavailable,
		clearSelection,
		selectionControls,
		disabled,
		refresh
	}: {
		collectionName: string;
		exportPipelines: readonly CollectionTablePipeline<TRow>[];
		importPipelines: readonly CollectionTablePipeline<TRow>[];
		integrations: readonly CollectionTableIntegrationStatus[];
		selectedRows: readonly TRow[];
		fields: readonly CollectionField[];
		updateSelected?: (
			fieldName: string,
			value: unknown,
			rows: readonly TRow[]
		) => Effect.Effect<void, unknown>;
		deleteSelected?: (rows: readonly TRow[]) => Effect.Effect<void, unknown>;
		updateUnavailable?: string | null;
		deleteUnavailable?: string | null;
		clearSelection?: () => void;
		selectionControls?: {
			readonly totalRows: number;
			readonly allSelected: boolean;
			toggleAll(): void;
		};
		disabled: boolean;
		refresh(): Effect.Effect<void, unknown>;
	} = $props();

	const { t } = useI18n<UiKeys>();

	let pendingOperation = $state<string | null>(null);
	let expandedSections = $state<string[]>(['export']);
	let selectedFieldName = $state<string | null>(null);
	let bulkValue: unknown = $state(undefined);
	let bulkValueTouched = $state(false);
	let actionsOpen = $state(false);
	let confirmUpdateOpen = $state(false);
	let confirmDeleteOpen = $state(false);
	const eligibleFields = $derived(
		fields.filter(
			(field) =>
				!isSystemField(field.name) &&
				!field.readOnly &&
				(field.relation != null || (!field.array && PRIMITIVE_FIELD_KINDS.has(field.kind)))
		)
	);
	const fieldOptions = $derived(
		eligibleFields.map((field) => ({
			value: field.name,
			label: field.label ?? humanize(field.name),
			description: field.relation
				? t('table.linksTo', { target: humanize(field.relation.target) })
				: undefined
		}))
	);
	const selectedField = $derived(eligibleFields.find((field) => field.name === selectedFieldName));
	const selectionLabel = $derived(
		selectedRows.length === 1
			? t('table.selectedRecord', { count: selectedRows.length })
			: t('table.selectedRecords', { count: selectedRows.length })
	);
	const canSubmitUpdate = $derived(
		Boolean(
			updateSelected &&
			selectedRows.length > 0 &&
			!updateUnavailable &&
			selectedField &&
			bulkValueTouched &&
			bulkValue !== undefined
		)
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
			selectedRows,
			refresh
		};
		Effect.runFork(
			pipeline.run(context).pipe(
				Effect.flatMap(() => (kind === 'import' ? refresh() : Effect.void)),
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

	function chooseField(fieldName: string | null): void {
		selectedFieldName = fieldName;
		bulkValue = undefined;
		bulkValueTouched = false;
	}

	function reviewBulkOperation(kind: BulkOperation): void {
		actionsOpen = false;
		Effect.runFork(
			Effect.tryPromise(() => tick()).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						if (kind === 'update') confirmUpdateOpen = true;
						else confirmDeleteOpen = true;
					})
				)
			)
		);
	}

	function runBulkOperation(kind: BulkOperation): void {
		if (
			pendingOperation ||
			disabled ||
			selectedRows.length === 0 ||
			(kind === 'update' ? updateUnavailable : deleteUnavailable)
		)
			return;
		pendingOperation = `bulk:${kind}`;
		Effect.runFork(
			Effect.gen(function* () {
				if (kind === 'update') {
					if (!updateSelected || !selectedField || !canSubmitUpdate) return;
					yield* updateSelected(selectedField.name, bulkValue, selectedRows);
					yield* Effect.sync(() =>
						toast.success(t('table.bulkUpdated', { label: selectionLabel }))
					);
				} else {
					if (!deleteSelected) return;
					yield* deleteSelected(selectedRows);
					yield* Effect.sync(() =>
						toast.success(t('table.bulkDeleted', { label: selectionLabel }))
					);
				}
				if (kind === 'update') confirmUpdateOpen = false;
				else confirmDeleteOpen = false;
				clearSelection?.();
				yield* refresh();
				if (kind === 'update') {
					bulkValue = undefined;
					bulkValueTouched = false;
				}
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						toast.error(error instanceof Error ? error.message : t('table.bulkFailed', { kind }));
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
		{#if updateSelected}
			<Accordion.Item value="bulk-update">
				<Accordion.Trigger class="px-2 hover:no-underline">
					<Inline gap="md">
						<Icon icon="lucide:list-restart" class="size-4 shrink-0" />
						<span>{t('table.bulkUpdate')}</span>
						<span class="rounded-full bg-muted px-2 py-0.5 text-meta">
							{selectedRows.length}
						</span>
					</Inline>
				</Accordion.Trigger>
				<Accordion.Content class="px-1">
					<Stack gap="md" class="rounded-md border bg-muted/30 p-3">
						{#if updateUnavailable}
							<p class="text-sm text-warning-foreground" role="status">{updateUnavailable}</p>
						{/if}
						<Stack gap="xs">
							<p class="text-xs font-medium">{t('table.bulkStep1')}</p>
							<Combobox
								options={fieldOptions}
								value={selectedFieldName}
								searchable={fieldOptions.length > 8}
								emptyPlaceholder={t('table.selectFieldPlaceholder')}
								ariaLabel={t('table.chooseFieldToUpdate')}
								disabled={disabled || Boolean(updateUnavailable) || selectedRows.length === 0}
								onValueChange={chooseField}
							/>
						</Stack>
						{#if selectedField}
							<Stack gap="xs">
								<label class="text-xs font-medium" for="collection-bulk-update-value">
									{t('table.bulkStep2')}
								</label>
								<DataRenderer
									id="collection-bulk-update-value"
									field={selectedField}
									value={bulkValue}
									mode="edit"
									disabled={disabled || pendingOperation != null}
									onValueChange={(value) => {
										bulkValue = value;
										bulkValueTouched = true;
									}}
								/>
							</Stack>
						{/if}
						<Inline justify="between" gap="md" class="border-t pt-3">
							<p class="text-meta">{selectionLabel}</p>
							<Button
								type="button"
								size="sm"
								disabled={disabled || pendingOperation != null || !canSubmitUpdate}
								onclick={() => void reviewBulkOperation('update')}
							>
								{t('table.bulkStep3')}
							</Button>
						</Inline>
					</Stack>
				</Accordion.Content>
			</Accordion.Item>
		{/if}
		{#if deleteSelected}
			<Accordion.Item value="delete">
				<Accordion.Trigger class="px-2 text-destructive hover:no-underline">
					<Inline gap="md">
						<Icon icon="lucide:trash-2" class="size-4 shrink-0" />
						<span>{t('table.deleteRecords')}</span>
						<span class="rounded-full bg-destructive/10 px-2 py-0.5 text-xs">
							{selectedRows.length}
						</span>
					</Inline>
				</Accordion.Trigger>
				<Accordion.Content class="px-1">
					<Inline
						justify="between"
						gap="md"
						class="rounded-md border border-destructive/30 bg-destructive/5 p-3"
					>
						<div class="min-w-0">
							<p class="text-meta">
								{t('table.deleteSelectedLabel', { label: selectionLabel })}
							</p>
							{#if deleteUnavailable}
								<p class="mt-1 text-sm text-warning-foreground" role="status">
									{deleteUnavailable}
								</p>
							{/if}
						</div>
						<Button
							type="button"
							variant="destructive"
							size="sm"
							disabled={disabled ||
								Boolean(deleteUnavailable) ||
								pendingOperation != null ||
								selectedRows.length === 0}
							onclick={() => void reviewBulkOperation('delete')}
						>
							{t('table.reviewDeletion')}
						</Button>
					</Inline>
				</Accordion.Content>
			</Accordion.Item>
		{/if}
	</Accordion.Root>
{/snippet}

<AlertDialog.Root bind:open={confirmUpdateOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title
				>{t('table.confirmUpdateTitle', { label: selectionLabel })}</AlertDialog.Title
			>
			<AlertDialog.Description>
				{t('table.confirmUpdateDescription', {
					field: selectedField?.label ?? selectedFieldName ?? ''
				})}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => void runBulkOperation('update')}>
				{t('table.confirmUpdate')}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={confirmDeleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title
				>{t('table.confirmDeleteTitle', { label: selectionLabel })}</AlertDialog.Title
			>
			<AlertDialog.Description>{t('table.confirmDeleteDescription')}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
				onclick={() => void runBulkOperation('delete')}
			>
				{t('table.deleteRecords')}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<Inline gap="xs" class="min-w-0">
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
