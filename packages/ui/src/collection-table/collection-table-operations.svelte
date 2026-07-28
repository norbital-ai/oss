<script lang="ts" generics="TRow extends object">
	import type { CollectionField } from '@norbital-ai/platform-utils/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { tick } from 'svelte';
	import * as Accordion from '#lib/accordion';
	import * as AlertDialog from '#lib/alert-dialog';
	import { Button, buttonVariants } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import { DataRenderer } from '../data-renderer/index.js';
	import * as Popover from '#lib/popover';
	import { toast } from 'svelte-sonner';
	import type {
		CollectionTableIntegrationStatus,
		CollectionTablePipeline,
		CollectionTablePipelineContext
	} from './collection-table.types.js';
	import CollectionTableIntegrationsPanel from './collection-table-integrations-panel.svelte';
	import CollectionTablePipelinePanel from './collection-table-pipeline-panel.svelte';

	type OperationKind = 'export' | 'import';
	type BulkOperation = 'update' | 'delete';
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
		updateSelected?: (fieldName: string, value: unknown, rows: readonly TRow[]) => Promise<void>;
		deleteSelected?: (rows: readonly TRow[]) => Promise<void>;
		clearSelection?: () => void;
		selectionControls?: {
			readonly totalRows: number;
			readonly allSelected: boolean;
			toggleAll(): void;
		};
		disabled: boolean;
		refresh(): Promise<void>;
	} = $props();

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
				!field.name.startsWith('norbital_') &&
				!field.readOnly &&
				(field.relation != null || (!field.array && PRIMITIVE_FIELD_KINDS.has(field.kind)))
		)
	);
	const fieldOptions = $derived(
		eligibleFields.map((field) => ({
			value: field.name,
			label: field.label ?? humanize(field.name),
			description: field.relation ? `Links to ${humanize(field.relation.target)}` : undefined
		}))
	);
	const selectedField = $derived(eligibleFields.find((field) => field.name === selectedFieldName));
	const selectionLabel = $derived(
		`${selectedRows.length} selected ${selectedRows.length === 1 ? 'record' : 'records'}`
	);
	const canSubmitUpdate = $derived(
		Boolean(
			updateSelected &&
			selectedRows.length > 0 &&
			selectedField &&
			bulkValueTouched &&
			bulkValue !== undefined
		)
	);

	async function runPipeline(
		kind: OperationKind,
		pipeline: CollectionTablePipeline<TRow>
	): Promise<void> {
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
		try {
			await pipeline.run(context);
			if (kind === 'import') await refresh();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : `${pipeline.label} failed`);
		} finally {
			pendingOperation = null;
		}
	}

	function chooseField(fieldName: string | null): void {
		selectedFieldName = fieldName;
		bulkValue = undefined;
		bulkValueTouched = false;
	}

	async function reviewBulkOperation(kind: BulkOperation): Promise<void> {
		actionsOpen = false;
		await tick();
		if (kind === 'update') confirmUpdateOpen = true;
		else confirmDeleteOpen = true;
	}

	async function runBulkOperation(kind: BulkOperation): Promise<void> {
		if (pendingOperation || disabled || selectedRows.length === 0) return;
		pendingOperation = `bulk:${kind}`;
		try {
			if (kind === 'update') {
				if (!updateSelected || !selectedField || !canSubmitUpdate) return;
				await updateSelected(selectedField.name, bulkValue, selectedRows);
				toast.success(`Updated ${selectionLabel}`);
			} else {
				if (!deleteSelected) return;
				await deleteSelected(selectedRows);
				toast.success(`Deleted ${selectionLabel}`);
			}
			if (kind === 'update') confirmUpdateOpen = false;
			else confirmDeleteOpen = false;
			clearSelection?.();
			await refresh();
			if (kind === 'update') {
				bulkValue = undefined;
				bulkValueTouched = false;
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : `Bulk ${kind} failed`);
		} finally {
			pendingOperation = null;
		}
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
	<div class="flex items-start justify-between gap-3 border-b px-4 py-3">
		<div class="min-w-0">
			<p class="text-sm font-semibold">Collection actions</p>
			<p class="mt-0.5 text-xs text-muted-foreground">
				Run configured pipelines or change selected records.
			</p>
		</div>
	</div>
	<div class="p-2">
		<Accordion.Root type="multiple" bind:value={expandedSections}>
			{#if importPipelines.length > 0}
				<Accordion.Item value="import">
					<Accordion.Trigger class="px-2 hover:no-underline">
						<span class="flex min-w-0 items-center gap-3">
							<Icon icon="lucide:upload" class="size-4 shrink-0" />
							<span>Import</span>
							<span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
								{importPipelines.length}
							</span>
						</span>
					</Accordion.Trigger>
					<Accordion.Content class="px-1">{@render pipelinePanel('import')}</Accordion.Content>
				</Accordion.Item>
			{/if}
			{#if exportPipelines.length > 0}
				<Accordion.Item value="export">
					<Accordion.Trigger class="px-2 hover:no-underline">
						<span class="flex min-w-0 items-center gap-3">
							<Icon icon="lucide:download" class="size-4 shrink-0" />
							<span>Export</span>
							<span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
								{exportPipelines.length}
							</span>
						</span>
					</Accordion.Trigger>
					<Accordion.Content class="px-1">{@render pipelinePanel('export')}</Accordion.Content>
				</Accordion.Item>
			{/if}
			{#if integrations.length > 0}
				<Accordion.Item value="integrations">
					<Accordion.Trigger class="px-2 hover:no-underline">
						<span class="flex min-w-0 items-center gap-3">
							<Icon icon="lucide:plug-zap" class="size-4 shrink-0" />
							<span>Integrations</span>
							<span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
								{integrations.length}
							</span>
						</span>
					</Accordion.Trigger>
					<Accordion.Content class="px-1">
						<CollectionTableIntegrationsPanel {integrations} />
					</Accordion.Content>
				</Accordion.Item>
			{/if}
			{#if updateSelected}
				<Accordion.Item value="bulk-update">
					<Accordion.Trigger class="px-2 hover:no-underline">
						<span class="flex min-w-0 items-center gap-3">
							<Icon icon="lucide:list-restart" class="size-4 shrink-0" />
							<span>Bulk update</span>
							<span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
								{selectedRows.length}
							</span>
						</span>
					</Accordion.Trigger>
					<Accordion.Content class="px-1">
						<div class="space-y-4 rounded-md border bg-muted/30 p-3">
							<div class="space-y-1.5">
								<p class="text-xs font-medium">1. Choose a field</p>
								<Combobox
									options={fieldOptions}
									value={selectedFieldName}
									searchable={fieldOptions.length > 8}
									emptyPlaceholder="Select a primitive or linked field"
									ariaLabel="Choose a field to update"
									disabled={disabled || selectedRows.length === 0}
									onValueChange={chooseField}
								/>
							</div>
							{#if selectedField}
								<div class="space-y-1.5">
									<label class="text-xs font-medium" for="collection-bulk-update-value">
										2. Set the new value
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
								</div>
							{/if}
							<div class="flex items-center justify-between gap-3 border-t pt-3">
								<p class="text-xs text-muted-foreground">{selectionLabel}</p>
								<Button
									type="button"
									size="sm"
									disabled={disabled || pendingOperation != null || !canSubmitUpdate}
									onclick={() => void reviewBulkOperation('update')}
								>
									3. Review update
								</Button>
							</div>
						</div>
					</Accordion.Content>
				</Accordion.Item>
			{/if}
			{#if deleteSelected}
				<Accordion.Item value="delete">
					<Accordion.Trigger class="px-2 text-destructive hover:no-underline">
						<span class="flex min-w-0 items-center gap-3">
							<Icon icon="lucide:trash-2" class="size-4 shrink-0" />
							<span>Delete records</span>
							<span class="rounded-full bg-destructive/10 px-2 py-0.5 text-xs">
								{selectedRows.length}
							</span>
						</span>
					</Accordion.Trigger>
					<Accordion.Content class="px-1">
						<div
							class="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
						>
							<p class="text-xs text-muted-foreground">Delete {selectionLabel}.</p>
							<Button
								type="button"
								variant="destructive"
								size="sm"
								disabled={disabled || pendingOperation != null || selectedRows.length === 0}
								onclick={() => void reviewBulkOperation('delete')}
							>
								Review deletion
							</Button>
						</div>
					</Accordion.Content>
				</Accordion.Item>
			{/if}
		</Accordion.Root>
	</div>
{/snippet}

<AlertDialog.Root bind:open={confirmUpdateOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Update {selectionLabel}?</AlertDialog.Title>
			<AlertDialog.Description>
				Every selected record will receive the same value for {selectedField?.label ??
					selectedFieldName}.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => void runBulkOperation('update')}>
				Confirm update
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={confirmDeleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {selectionLabel}?</AlertDialog.Title>
			<AlertDialog.Description>
				This permanently removes the selected records. Linked records or collection policy may block
				the deletion.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
				onclick={() => void runBulkOperation('delete')}
			>
				Delete records
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<div class="flex min-w-0 items-center gap-1">
	<Popover.Root bind:open={actionsOpen}>
		<Popover.Trigger
			class={buttonVariants({ variant: 'ghost', size: 'icon' })}
			aria-label="Open collection actions"
			title="Collection actions"
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
		<span class="text-xs tabular-nums text-muted-foreground">
			{selectedRows.length} selected
		</span>
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="ml-auto h-8"
			disabled={disabled || selectionControls.totalRows === 0}
			onclick={selectionControls.toggleAll}
		>
			{selectionControls.allSelected ? 'Clear all' : 'Select all'}
		</Button>
	{/if}
</div>
