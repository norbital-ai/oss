<!--
	The inbox (§3.8 "where it shows", rule 46): open requests the viewer may decide, supersede or withdraw, in ui's
	`Table`. Decisions are `bolt.approvals.*`; the host decides eligibility. Opening a request shows its committed
	record or native create proposal. Notices are the bell's (`Bell.svelte`), not listed here a second time.
-->
<script lang="ts">
	import { live, fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { watch } from 'runed';
	import { Picker, Table, format, label, openRecord, singular } from '@norbital-ai/ui';
	import type { InboxRequest } from './data.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { Act } from '../Acts.svelte';
	import Acts from '../Acts.svelte';
	import SystemPage from '../SystemPage.svelte';

	/** `onCount`: the requests the viewer may decide, as it changes: the sidebar's badge. */
	let {
		bolt,
		t,
		onCount
	}: { bolt: ShellBolt; t: (key: string) => string; onCount?: (n: number) => void } = $props();

	// svelte-ignore state_referenced_locally
	const inbox = live(() =>
		bolt.live<{ requests: InboxRequest[] }>({ read: { m: 'inbox', a: [{ requests: true }] } })
	);
	const requests = $derived($inbox?.requests ?? null);
	let message = $state<string | null>(null);
	const LABEL: { readonly [status: string]: string } = {
		APPROVED: 'Approve',
		REQUEST_FOR_CHANGE: 'Request changes',
		REJECTED: 'Reject',
		SUPERSEDED: 'Supersede',
		RESUBMITTED: 'Resubmit',
		WITHDRAWN: 'Withdraw',
		CLOSED: 'Close'
	};

	const decide = Effect.fn('Inbox.decide')(function* (
		r: InboxRequest,
		move: InboxRequest['moves'][number]
	) {
		// the state machine says which moves need a reason (request changes, supersede)
		const reason = move.reason === 'required' ? prompt(t('Reason')) : null;
		if (move.reason === 'required' && !reason) return;
		const result = yield* Effect.result(
			bolt.approvals.process(r.id, { status: move.status, ...(reason ? { reason } : {}) })
		);
		message =
			result._tag === 'Success'
				? null
				: result.failure._tag === 'ActRefused'
					? result.failure.message
					: result.failure._tag === 'ActConflict'
						? t('This request is no longer pending.')
						: t('The outcome is unknown; refresh to see it.');
	});
	// the host's moves for this viewer (approvals/machine.ts): the buttons always match what the engine allows
	const decisions = (r: InboxRequest): Act[] =>
		r.moves.map((move, i) => ({
			label: t(LABEL[move.status] ?? move.status),
			run: () => fork(decide(r, move)),
			...(i === 0 ? { variant: 'default' as const } : {})
		}));
	// the collection's catalog label and the action as a verb (`create` → `Create`); `collection` stays the key openRecord needs
	const verb = (a: string) => {
		const s = t(a);
		return s !== a ? s : a.replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase());
	};
	const requestRows = $derived(
		(requests ?? []).map((r) => ({
			...r,
			of: label(bolt, r.collection),
			verb: verb(r.action),
			progress:
				r.status === 'CHANGES_REQUESTED' ? t('Changes requested') : `${r.step + 1}/${r.steps}`
		}))
	);

	const waiting = $derived(requests === null ? null : requests.filter((r) => r.canDecide).length);
	watch(
		() => waiting,
		(n) => {
			if (n !== null) onCount?.(n);
		}
	);

	const when = (v: unknown) =>
		typeof v === 'string' ? format({ kind: 'instant' }, v, { locale: bolt.locale }) : '—';
</script>

{#snippet at({ value }: { row: object; value: unknown })}<time class="tabular-nums"
		>{when(value)}</time
	>{/snippet}
<!-- which record: its own label (a trial's title, a submission's name) through the reviewer's read grant, never an id -->
{#snippet record_({ row }: { row: InboxRequest; value: unknown })}
	{#if row.action === 'create'}<span>{t('New')} {singular(bolt, row.collection)}</span>
	{:else}<span class="[&_[data-readonly]]:text-xs"
			><Picker of={row.collection} value={row.record} onChange={() => {}} readonly /></span
		>{/if}
{/snippet}
{#snippet decide_({ row }: { row: InboxRequest; value: unknown })}<Acts
		acts={decisions(row)}
	/>{/snippet}

<SystemPage name="inbox" title={t('Inbox')} error={message ?? inbox.error?.message ?? null}>
	{#if requests === null}
		<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
	{:else}
		<Table
			of={requestRows}
			key="approvals"
			toolbar={{ title: t('Approvals'), export: true }}
			onOpen={(r) => openRecord(r.collection, r.record)}
			columns={[
				{ field: 'record', label: t('Record'), cell: record_ },
				{ field: 'of', label: t('Collection') },
				{ field: 'verb', label: t('Action') },
				{ field: 'progress', label: t('Step') },
				{ field: 'by', label: t('Requested by') },
				{ field: 'at', label: t('When'), cell: at },
				{ field: 'id', label: t('Actions'), hide: 'narrow', cell: decide_ }
			]}
		>
			{#snippet empty()}<p class="text-sm text-muted-foreground">
					{t('Nothing waits on you.')}
				</p>{/snippet}
		</Table>
	{/if}
</SystemPage>
