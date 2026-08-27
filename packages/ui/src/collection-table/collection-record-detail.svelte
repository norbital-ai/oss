<script lang="ts">
	import type {
		CollectionApprovalRequest,
		CollectionDefinition,
		CollectionOperations,
		CollectionQuery,
		CollectionRecord,
		CollectionType
	} from '@norbital-ai/std/collection';
	import { resolveRecordLabel } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '#lib/button';
	import * as Dialog from '#lib/dialog';
	import { Textarea } from '#lib/textarea';
	import { cn } from '#lib/utils';
	import { useI18n } from '#lib/i18n';
	import { Cluster, Inline, Stack } from '#lib/layout';
	import CollectionRecordDetailTabs from './collection-record-detail-tabs.svelte';
	import CollectionRecordDetailEmpty from './collection-record-detail-empty.svelte';
	import {
		getOptionalCollectionClientGetter,
		getCollectionSurfaceRuntime,
		resolveCollectionSurface
	} from '#lib/collection-runtime';
	import { approvalRequestIdForRecord } from './approval-anchor.js';
	import { approvalActionsFor } from './approval-actions.js';

	type ErasedCollection = CollectionType<CollectionRecord, object>;

	type ApprovalActionState =
		| { status: 'idle' }
		| { status: 'pending' }
		| { status: 'requesting_changes'; reason: string; pending: boolean }
		| { status: 'superseding'; reason: string; pending: boolean };

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

	const { t } = useI18n();

	/**
	 * The record surface, resolved from the workspace rather than from whatever table is on screen.
	 *
	 * Both facts a record sheet needs — the collection's definition and its authored
	 * `+representation.svelte` — are properties of the compiled workspace, published above this
	 * surface by the shell. Reading them here is what lets a `?stack=` frame render a record whose
	 * table is on an unopened tab, or on no screen at all.
	 */
	const clientGetter = getOptionalCollectionClientGetter();
	const client = $derived(clientGetter?.());
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
						where: {
							[recordIdField]: { eq: recordId }
						} as CollectionQuery<CollectionRecord>['where'], // stupidity: boundary-cast — the record key is a runtime string on an erased row.
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

	let approvalActionState = $state<ApprovalActionState>({ status: 'idle' });
	let changeRequestOpen = $state(false);
	let supersedeOpen = $state(false);
	const approvalActionPending = $derived(
		approvalActionState.status === 'pending' ||
			((approvalActionState.status === 'requesting_changes' ||
				approvalActionState.status === 'superseding') &&
				approvalActionState.pending)
	);
	const changeRequestReason = $derived(
		approvalActionState.status === 'requesting_changes' ? approvalActionState.reason : ''
	);
	const supersedeReason = $derived(
		approvalActionState.status === 'superseding' ? approvalActionState.reason : ''
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
	const approvalActions = $derived(approvalActionsFor(approvalRequest));
	const approvalStatusMessage = $derived(
		approvalQuery?.loading
			? t('table.approvalLoading')
			: approvalRequest?.status === 'ONGOING'
				? t('table.approvalAwaiting')
				: t('table.approvalStatus', {
						status: approvalRequest?.status ?? t('common.unknown')
					})
	);

	function recordTitle(row: CollectionRecord): string {
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
		return humanize(collectionName);
	}

	function approvalActionSuccessMessage(
		action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED'
	): string {
		switch (action) {
			case 'APPROVED':
				return t('table.approvalApproved');
			case 'REJECTED':
				return t('table.approvalRejected');
			case 'REQUEST_FOR_CHANGE':
				return t('table.approvalChangesRequested');
			case 'SUPERSEDED':
				return t('table.approvalSuperseded');
			default:
				return action satisfies never;
		}
	}

	function processApproval(
		action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED',
		comments?: string
	): Effect.Effect<boolean> {
		const approvals = client?.approvals;
		const allowed = action === 'SUPERSEDED' ? approvalActions.supersede : approvalActions.decide;
		if (!allowed || !activeApprovalId || !approvals) return Effect.succeed(false);
		const approvalId = activeApprovalId;
		approvalActionState =
			action === 'REQUEST_FOR_CHANGE'
				? { status: 'requesting_changes', reason: comments ?? '', pending: true }
				: action === 'SUPERSEDED'
					? { status: 'superseding', reason: comments ?? '', pending: true }
					: { status: 'pending' };
		return Effect.tryPromise({
			try: () => approvals.process({ approvalRequestId: approvalId, action, comments }),
			catch: (cause) => cause
		}).pipe(
			Effect.map(() => {
				if (action === 'REQUEST_FOR_CHANGE') changeRequestOpen = false;
				if (action === 'SUPERSEDED') supersedeOpen = false;
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
							: action === 'SUPERSEDED'
								? { status: 'superseding', reason: comments ?? '', pending: false }
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
		Effect.runFork(processApproval('REQUEST_FOR_CHANGE', reason));
	}

	function openSupersede(): void {
		approvalActionState = { status: 'superseding', reason: '', pending: false };
		supersedeOpen = true;
	}

	function closeSupersede(): void {
		if (approvalActionPending) return;
		supersedeOpen = false;
		approvalActionState = { status: 'idle' };
	}

	function updateSupersedeReason(reason: string): void {
		if (approvalActionState.status !== 'superseding') return;
		approvalActionState = { ...approvalActionState, reason };
	}

	function supersedeApproval(): void {
		const reason = supersedeReason.trim();
		if (!reason) return;
		Effect.runFork(processApproval('SUPERSEDED', reason));
	}

	function withdrawApproval(): void {
		const approvals = client?.approvals;
		if (!approvalActions.withdraw || !activeApprovalId || !approvals) return;
		approvalActionState = { status: 'pending' };
		void Effect.runPromise(
			Effect.tryPromise({
				try: () => approvals.withdraw(activeApprovalId),
				catch: (cause) => cause
			}).pipe(
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
		<CollectionRecordDetailEmpty
			icon="lucide:file-warning"
			title={t('table.noCustomView')}
			description={t('table.noCustomViewDesc')}
		/>
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
							approvalRequest.status === 'CHANGES_REQUESTED' &&
								'bg-warning/15 text-warning-foreground',
							approvalRequest.status === 'ONGOING' && 'bg-brand/10 text-brand',
							!['APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'ONGOING'].includes(
								approvalRequest.status
							) && 'bg-muted text-muted-foreground'
						)}
					>
						<Icon
							icon={approvalRequest.status === 'APPROVED'
								? 'lucide:circle-check'
								: approvalRequest.status === 'REJECTED'
									? 'lucide:circle-x'
									: approvalRequest.status === 'CHANGES_REQUESTED'
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
									approvalRequest.status === 'CHANGES_REQUESTED' &&
										'border-warning/30 bg-warning/15 text-warning-foreground',
									approvalRequest.status === 'ONGOING' && 'border-brand/25 bg-brand/10 text-brand'
								)}>{humanize(approvalRequest.status)}</span
							>
						</Inline>
						<p class="text-sm leading-5 text-muted-foreground">{approvalStatusMessage}</p>
					</Stack>
				</Inline>
				{#if approvalActions.decide || approvalActions.supersede || approvalActions.withdraw}
					<Cluster gap="sm" class="border-t pt-4">
						{#if approvalActions.decide}
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
						{/if}
						{#if approvalActions.supersede}
							<Button variant="outline" disabled={approvalActionPending} onclick={openSupersede}>
								<Icon icon="lucide:shield-check" class="mr-1.5 size-3.5" aria-hidden="true" />
								{t('table.supersedeApproval')}
							</Button>
						{/if}
						{#if approvalActions.withdraw}
							<Button variant="ghost" disabled={approvalActionPending} onclick={withdrawApproval}
								>{t('table.withdrawRequest')}</Button
							>
						{/if}
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
		<label class="text-sm font-medium">
			<Stack gap="xs">
				{t('table.changeRequestReason')}
				<Textarea
					value={changeRequestReason}
					placeholder={t('table.describeChangesPlaceholder')}
					maxlength={1000}
					required
					oninput={(event) => updateChangeRequestReason(event.currentTarget.value)}
				/>
			</Stack>
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

<Dialog.Root open={supersedeOpen} onOpenChange={(open) => !open && closeSupersede()}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{t('table.supersedeApproval')}</Dialog.Title>
			<Dialog.Description>{t('table.supersedeApprovalDescription')}</Dialog.Description>
		</Dialog.Header>
		<label class="text-sm font-medium">
			<Stack gap="xs">
				{t('table.supersedeReason')}
				<Textarea
					value={supersedeReason}
					placeholder={t('table.supersedeReasonPlaceholder')}
					maxlength={1000}
					required
					oninput={(event) => updateSupersedeReason(event.currentTarget.value)}
				/>
			</Stack>
		</label>
		<Dialog.Footer>
			<Dialog.Close disabled={approvalActionPending}>{t('common.cancel')}</Dialog.Close>
			<Button
				disabled={approvalActionPending || supersedeReason.trim().length === 0}
				onclick={() => void supersedeApproval()}
			>
				{approvalActionPending ? t('table.supersedingApproval') : t('table.supersedeApproval')}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
