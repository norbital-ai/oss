<script lang="ts">
	import type {
		CollectionApprovalRequest,
		CollectionDefinition,
		CollectionField,
		CollectionOperations,
		CollectionQuery,
		CollectionRecord,
		CollectionType
	} from '@norbital-ai/std/collection';
	import { resolveRecordLabel } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { Array as Array_, Effect, Result } from 'effect';
	import type { Snippet } from 'svelte';
	import { watch } from 'runed';
	import { toast } from 'svelte-sonner';
	import { Button } from '#lib/button';
	import * as Dialog from '#lib/dialog';
	import { Textarea } from '#lib/textarea';
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cluster, Grid, Inline, Stack } from '#lib/layout';
	import { DataRenderer, formatDataValue, type Translate } from '#lib/data-renderer';
	import { CollectionForm } from '#lib/collection-form';
	import CollectionRecordDetailTabs from './collection-record-detail-tabs.svelte';
	import CollectionRecordDetailEmpty from './collection-record-detail-empty.svelte';
	import { isSystemField } from '#lib/collection-table/collection-card-derivation';
	import {
		getOptionalCollectionClientContext,
		getCollectionSurfaceRuntime,
		resolveCollectionSurface
	} from '#lib/collection-runtime';
	import { approvalRequestIdForRecord } from './approval-anchor.js';

	type Row = CollectionRecord;
	type ErasedCollection = CollectionType<Row, object, object>;

	type ApprovalActionState =
		| { status: 'idle' }
		| { status: 'pending' }
		| { status: 'requesting_changes'; reason: string; pending: boolean };

	let {
		collectionName,
		recordId,
		actions,
		onClose
	}: {
		collectionName: string;
		recordId: string;
		actions?: Snippet;
		onClose: () => void;
	} = $props();

	const { t } = useI18n<UiKeys>();

	/**
	 * The record surface, resolved from the workspace rather than from whatever table is on screen.
	 *
	 * Both facts a record sheet needs — the collection's definition and its authored
	 * `+representation.svelte` — are properties of the compiled workspace, published above this
	 * surface by the shell. Reading them here is what lets a `?stack=` frame render a record whose
	 * table is on an unopened tab, or on no screen at all.
	 */
	const client = getOptionalCollectionClientContext();
	const surfaceRuntime = getCollectionSurfaceRuntime();
	const collectionSurface = $derived(
		resolveCollectionSurface(surfaceRuntime?.surfaces, collectionName)
	);
	const definition = $derived(
		client?.collections[collectionName] as CollectionDefinition<ErasedCollection> | undefined // stupidity: boundary-cast — the generated client and the URL stack share collection keys.
	);
	const operations = $derived(
		client?.db[collectionName] as CollectionOperations<ErasedCollection> | undefined // stupidity: boundary-cast — the generated client indexes collections by the same key the stack names.
	);
	const recordIdField = 'id';

	const recordQueryInput = $derived(
		operations
			? {
					operations,
					query: {
						where: { [recordIdField]: { eq: recordId } } as CollectionQuery<Row>['where'], // stupidity: boundary-cast — the record key is a runtime string on an erased row.
						limit: 1
					}
				}
			: null
	);
	const recordQuery = $derived(
		recordQueryInput ? recordQueryInput.operations.findMany(recordQueryInput.query) : null
	);
	const record = $derived.by(() => {
		const found = recordQuery?.current?.[0];
		// Remote queries retain the previous result while a new key in the same family loads. Never
		// mount a stateful representation with that carry-over row: its form captures the record id at
		// construction, so showing record B with record A's form would send edits to the wrong row.
		if (!found || String(Reflect.get(found, recordIdField)) !== recordId) return undefined;
		return found;
	});
	const recordLoading = $derived(Boolean(recordQuery?.loading));
	const recordError = $derived(recordQuery?.error?.message);

	/**
	 * Split the definition's fields once rather than filtering it twice — both the raw and the
	 * system group are the same slice of the same list.
	 */
	const rawFieldGroups = $derived(
		Array_.partition(definition?.fields ?? [], (field) =>
			isSystemField(field.name) ? Result.fail(field) : Result.succeed(field)
		)
	);
	const rawRecordFields = $derived(rawFieldGroups[1]);
	const rawSystemFields = $derived(rawFieldGroups[0]);

	let approvalActionState = $state<ApprovalActionState>({ status: 'idle' });
	let changeRequestOpen = $state(false);
	const approvalActionPending = $derived(
		approvalActionState.status === 'pending' ||
			(approvalActionState.status === 'requesting_changes' && approvalActionState.pending)
	);
	const changeRequestReason = $derived(
		approvalActionState.status === 'requesting_changes' ? approvalActionState.reason : ''
	);
	const activeApprovalId = $derived(approvalRequestIdForRecord(collectionName, record));
	const approvalQueryInput = $derived(
		activeApprovalId && client?.approvals
			? { approvalId: activeApprovalId, approvals: client.approvals }
			: null
	);
	const approvalQuery = $derived(
		approvalQueryInput ? approvalQueryInput.approvals.findMany(approvalQueryInput.approvalId) : null
	);
	const approvalRequest = $derived(approvalQuery?.current?.[0]);
	const approvalStatusMessage = $derived(
		approvalQuery?.loading
			? t('table.approvalLoading')
			: approvalRequest?.status === 'ONGOING'
				? t('table.approvalAwaiting')
				: t('table.approvalStatus', {
						status: approvalRequest?.status ?? t('common.unknown')
					})
	);

	function recordTitle(row: Row): string {
		if (!definition) return humanize(collectionName);
		// Bolt declares `recordLabel` as a plain column name — `recordLabel: 'summary'`. The CEL
		// resolver evaluates it as an expression and returns null for a bare identifier, so the title
		// fell through to the first non-uuid column, which on a leave request is the raw event JSON.
		// A bare name is read as what it is; anything else is still an expression.
		const declared = definition.recordLabel ?? null;
		if (declared && /^[A-Za-z_][A-Za-z0-9_]*$/.test(declared)) {
			const value = Reflect.get(row, declared);
			if (typeof value === 'string' && value.trim() !== '') return value;
		}
		const label = resolveRecordLabel(declared, row);
		if (label) return label;
		const fallbackField = definition.fields.find(
			(field) => !isSystemField(field.name) && field.kind !== 'uuid' && !field.name.endsWith('_id')
		);
		const fallback = fallbackField
			? formatDataValue(
					fallbackField,
					Reflect.get(row, fallbackField.name),
					undefined,
					t as Translate
				)
			: '';
		return fallback && fallback !== '—' ? fallback : humanize(collectionName);
	}

	function formatRawStructuredValue(value: unknown): string {
		if (value == null) return '—';
		return Effect.runSync(
			Effect.try(() => JSON.stringify(value, null, 2) ?? String(value)).pipe(
				Effect.match({
					onFailure: () => String(value),
					onSuccess: (text) => text
				})
			)
		);
	}

	function approvalActionSuccessMessage(
		action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE'
	): string {
		switch (action) {
			case 'APPROVED':
				return t('table.approvalApproved');
			case 'REJECTED':
				return t('table.approvalRejected');
			case 'REQUEST_FOR_CHANGE':
				return t('table.approvalChangesRequested');
			default:
				return action satisfies never;
		}
	}

	function processApproval(
		action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE',
		comments?: string
	): Effect.Effect<boolean> {
		const approvals = client?.approvals;
		if (!activeApprovalId || !approvals) return Effect.succeed(false);
		const approvalId = activeApprovalId;
		approvalActionState =
			action === 'REQUEST_FOR_CHANGE'
				? { status: 'requesting_changes', reason: comments ?? '', pending: true }
				: { status: 'pending' };
		return Effect.tryPromise(() =>
			approvals.process({ approvalRequestId: approvalId, action, comments })
		).pipe(
			Effect.map(() => {
				if (action === 'REQUEST_FOR_CHANGE') changeRequestOpen = false;
				approvalActionState = { status: 'idle' };
				toast.success(approvalActionSuccessMessage(action));
				return true;
			}),
			Effect.catch((error) =>
				Effect.sync(() => {
					toast.error(error instanceof Error ? error.message : t('table.approvalActionFailed'));
					approvalActionState =
						action === 'REQUEST_FOR_CHANGE'
							? { status: 'requesting_changes', reason: comments ?? '', pending: false }
							: { status: 'idle' };
					return false;
				})
			)
		);
	}

	function openChangeRequest(): void {
		approvalActionState = { status: 'requesting_changes', reason: '', pending: false };
		changeRequestOpen = true;
	}

	function closeChangeRequest(): void {
		if (approvalActionPending) return;
		changeRequestOpen = false;
		approvalActionState = { status: 'idle' };
	}

	function updateChangeRequestReason(reason: string): void {
		if (approvalActionState.status !== 'requesting_changes') return;
		approvalActionState = { ...approvalActionState, reason };
	}

	function requestChanges(): void {
		const reason = changeRequestReason.trim();
		if (!reason) return;
		void Effect.runPromise(processApproval('REQUEST_FOR_CHANGE', reason));
	}

	function withdrawApproval(): void {
		const approvals = client?.approvals;
		if (!activeApprovalId || !approvals) return;
		approvalActionState = { status: 'pending' };
		void Effect.runPromise(
			Effect.tryPromise(() => approvals.withdraw(activeApprovalId)).pipe(
				Effect.tap(() => Effect.sync(() => toast.success(t('table.approvalWithdrawn')))),
				Effect.catch((error) =>
					Effect.sync(() => {
						toast.error(error instanceof Error ? error.message : t('table.approvalWithdrawFailed'));
					})
				),
				Effect.onExit(() =>
					Effect.sync(() => {
						approvalActionState = { status: 'idle' };
					})
				)
			)
		);
	}
</script>

{#snippet uiDetails()}
	{#if record && collectionSurface?.representation}
		{@const Representation = collectionSurface.representation}
		{#key recordId}
			<Representation {record} close={onClose} />
		{/key}
	{:else if record && client}
		<!-- Default detail surface (RFC V.2/V.6): a schema-derived form bound to the record. -->
		{#key recordId}
			<CollectionForm {client} collection={collectionName} defaultValues={record} />
		{/key}
	{:else}
		<CollectionRecordDetailEmpty
			icon="lucide:panel-top-dashed"
			title={t('table.noCustomView')}
			description={t('table.noCustomViewDesc')}
		/>
	{/if}
{/snippet}

{#snippet approvalDetails()}
	<Stack gap="md">
		{#if approvalQuery?.loading}
			<Inline
				gap="sm"
				class="rounded-lg border bg-card p-4 text-sm text-muted-foreground"
				role="status"
			>
				<Icon icon="lucide:loader-circle" class="size-4 animate-spin" aria-hidden="true" />
				{t('table.approvalLoading')}
			</Inline>
		{:else if approvalRequest}
			<Stack gap="md" class="rounded-lg border bg-card p-4">
				<Inline align="start" gap="md">
					<div
						class={cn(
							'flex size-9 shrink-0 items-center justify-center rounded-full',
							approvalRequest.status === 'APPROVED' && 'bg-success/10 text-success',
							approvalRequest.status === 'REJECTED' && 'bg-destructive/10 text-destructive',
							approvalRequest.status === 'REQUEST_FOR_CHANGE' &&
								'bg-warning/15 text-warning-foreground',
							approvalRequest.status === 'ONGOING' && 'bg-brand/10 text-brand',
							!['APPROVED', 'REJECTED', 'REQUEST_FOR_CHANGE', 'ONGOING'].includes(
								approvalRequest.status
							) && 'bg-muted text-muted-foreground'
						)}
					>
						<Icon
							icon={approvalRequest.status === 'APPROVED'
								? 'lucide:circle-check'
								: approvalRequest.status === 'REJECTED'
									? 'lucide:circle-x'
									: approvalRequest.status === 'REQUEST_FOR_CHANGE'
										? 'lucide:message-square-warning'
										: approvalRequest.status === 'ONGOING'
											? 'lucide:clock-3'
											: 'lucide:shield-check'}
							class="size-4"
							aria-hidden="true"
						/>
					</div>
					<Stack gap="xs" grow>
						<Inline gap="sm" justify="between">
							<p class="text-sm font-medium">{t('table.approvalRequest')}</p>
							<span
								class={cn(
									'rounded-full border px-2 py-0.5 text-xs font-medium',
									approvalRequest.status === 'APPROVED' &&
										'border-success/25 bg-success/10 text-success',
									approvalRequest.status === 'REJECTED' &&
										'border-destructive/25 bg-destructive/10 text-destructive',
									approvalRequest.status === 'REQUEST_FOR_CHANGE' &&
										'border-warning/30 bg-warning/15 text-warning-foreground',
									approvalRequest.status === 'ONGOING' && 'border-brand/25 bg-brand/10 text-brand'
								)}>{humanize(approvalRequest.status)}</span
							>
						</Inline>
						<p class="text-sm leading-5 text-muted-foreground">{approvalStatusMessage}</p>
						<p
							class="truncate font-mono text-micro text-muted-foreground"
							title={approvalRequest.id}
						>
							{t('table.approvalRequestId')}: {approvalRequest.id}
						</p>
					</Stack>
				</Inline>
				{#if approvalRequest.status === 'ONGOING'}
					<Cluster gap="sm" class="border-t pt-4">
						<Button
							disabled={approvalActionPending}
							onclick={() => void Effect.runPromise(processApproval('APPROVED'))}
						>
							<Icon icon="lucide:check" class="mr-1.5 size-3.5" aria-hidden="true" />
							{t('table.approve')}
						</Button>
						<Button variant="outline" disabled={approvalActionPending} onclick={openChangeRequest}
							>{t('table.requestChanges')}</Button
						>
						<Button
							variant="outline"
							class="text-destructive hover:text-destructive"
							disabled={approvalActionPending}
							onclick={() => void Effect.runPromise(processApproval('REJECTED'))}
						>
							{t('table.reject')}</Button
						>
						<Button variant="ghost" disabled={approvalActionPending} onclick={withdrawApproval}
							>{t('table.withdrawRequest')}</Button
						>
					</Cluster>
				{/if}
			</Stack>
		{:else}
			<CollectionRecordDetailEmpty
				icon="lucide:shield-check"
				title={t('table.noApprovalRequest')}
				description={t('table.noApprovalRequestDesc')}
			/>
		{/if}
	</Stack>
{/snippet}

{#snippet rawFieldGrid({
	record,
	fields,
	className
}: {
	record: Row;
	fields: readonly CollectionField[];
	className?: string;
})}
	<Grid as="dl" minimum="compact" gap="md" class={className}>
		{#each fields as field (field.name)}
			<div class="min-w-0">
				<dt class="text-xs font-medium leading-4 text-muted-foreground">
					{field.label ?? humanize(field.name)}
				</dt>
				<dd class="mt-0.5 min-w-0 break-words text-sm leading-5">
					{#if field.kind === 'json'}
						<pre
							class="whitespace-pre-wrap break-words font-mono text-xs leading-5">{formatRawStructuredValue(
								Reflect.get(record, field.name)
							)}</pre>
					{:else}
						<DataRenderer {field} value={Reflect.get(record, field.name)} mode="display" />
					{/if}
				</dd>
			</div>
		{/each}
	</Grid>
{/snippet}

{#snippet rawDetails()}
	{#if record}
		<Stack gap="md">
			{#if rawRecordFields.length > 0}
				{@render rawFieldGrid({
					record,
					fields: rawRecordFields,
					className: 'rounded-lg border bg-card p-3'
				})}
			{/if}
			{#if rawSystemFields.length > 0}
				<details class="group rounded-lg border bg-muted/15">
					<summary
						class="cursor-pointer list-none rounded-lg px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					>
						<Inline gap="sm" justify="between">
							<Inline gap="sm">
								<Icon
									icon="lucide:database"
									class="size-3.5 text-muted-foreground"
									aria-hidden="true"
								/>
								<span class="text-sm font-medium">{t('table.systemFields')}</span>
								<span class="text-meta">{rawSystemFields.length}</span>
							</Inline>
							<Icon
								icon="lucide:chevron-down"
								class="size-4 text-muted-foreground transition-transform group-open:rotate-180"
								aria-hidden="true"
							/>
						</Inline>
					</summary>
					{@render rawFieldGrid({
						record,
						fields: rawSystemFields,
						className: 'border-t p-3'
					})}
				</details>
			{/if}
		</Stack>
	{/if}
{/snippet}

{#if client && definition}
	<CollectionRecordDetailTabs
		title={record ? recordTitle(record) : humanize(collectionName)}
		description={t('table.recordDetails', { name: humanize(collectionName) })}
		loading={recordLoading}
		error={recordError}
		found={Boolean(record)}
		{actions}
		banner={collectionSurface?.banner ?? null}
		ui={uiDetails}
		approval={approvalDetails}
		raw={rawDetails}
	/>
{:else}
	<!--
		No collection client above this surface, or no such collection in this workspace. Unlike the
		registration miss this replaced, both are terminal facts about the workspace rather than a
		race with a mount, so saying so is honest the moment it renders.
	-->
	<p class="p-5 text-sm text-muted-foreground">{t('table.detailUnavailable')}</p>
{/if}

<Dialog.Root open={changeRequestOpen} onOpenChange={(open) => !open && closeChangeRequest()}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{t('table.requestChanges')}</Dialog.Title>
			<Dialog.Description>{t('table.requestChangesDescription')}</Dialog.Description>
		</Dialog.Header>
		<label class="grid gap-1.5 text-sm font-medium">
			{t('table.changeRequestReason')}
			<Textarea
				value={changeRequestReason}
				placeholder={t('table.describeChangesPlaceholder')}
				maxlength={1000}
				required
				oninput={(event) => updateChangeRequestReason(event.currentTarget.value)}
			/>
		</label>
		<Dialog.Footer>
			<Dialog.Close disabled={approvalActionPending}>{t('common.cancel')}</Dialog.Close>
			<Button
				disabled={approvalActionPending || changeRequestReason.trim().length === 0}
				onclick={() => void requestChanges()}
			>
				{approvalActionPending ? t('table.requesting') : t('table.requestChanges')}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
