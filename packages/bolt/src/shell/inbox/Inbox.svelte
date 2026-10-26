<!--
	The inbox (§3.8 "where it shows", rule 46): open requests the viewer may decide (a superseder's Approve supersedes),
	and their own requests that ask for changes, in ui's `Table`. Decisions are `bolt.approvals.decide`; the host decides
	eligibility. Opening a request shows its committed record or native create proposal; saving that record resubmits a
	request that asks for changes. Notices are the bell's (`Bell.svelte`), not listed here a second time.
-->
<script lang="ts">
	import { observe, fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { watch } from 'runed';
	import {
		Button,
		Dialog,
		Picker,
		Table,
		Textarea,
		format,
		label,
		openRecord,
		singular
	} from '@norbital-ai/ui';
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
	const inbox = observe(() =>
		bolt.observe<{ requests: readonly InboxRequest[] }>({
			read: { m: 'inbox', a: [{ requests: true }] }
		})
	);
	const requests = $derived(inbox.current?.requests ?? null);
	let message = $state<string | null>(null);
	let chosen = $state<{ request: InboxRequest; move: Decision } | null>(null);
	let reason = $state('');
	let busy = $state(false);
	const reasonId = $props.id();
	type Decision = InboxRequest['moves'][number];
	const LABEL: { readonly [D in Decision['decision']]: string } = {
		approve: 'Approve',
		reject: 'Reject',
		requestChanges: 'Request changes'
	};
	const ORDER: readonly Decision['decision'][] = ['approve', 'reject', 'requestChanges'];
	const decide = Effect.fn('Inbox.decide')(function* (
		r: InboxRequest,
		move: Decision,
		note: string = ''
	) {
		if (busy || (move.reason === 'required' && note.trim() === '')) return;
		busy = true;
		message = null;
		yield* Effect.gen(function* () {
			const result = yield* Effect.result(
				bolt.approvals.decide(r.id, {
					decision: move.decision,
					...(note.trim() ? { reason: note.trim() } : {})
				})
			);
			message =
				result._tag === 'Success'
					? null
					: result.failure._tag === 'ActRefused'
						? result.failure.message
						: result.failure._tag === 'ActConflict'
							? t('This request is no longer pending.')
							: t('The outcome is unknown; refresh to see it.');
			if (result._tag === 'Success') {
				chosen = null;
				reason = '';
			}
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					busy = false;
				})
			)
		);
	});
	const choose = (request: InboxRequest, move: Decision) => {
		if (busy) return;
		if (move.reason === 'required') {
			chosen = { request, move };
			reason = '';
			message = null;
		} else fork(decide(request, move));
	};
	const keepWhileBusy = (event: Event) => {
		if (busy) event.preventDefault();
	};
	// The host's decisions for this viewer; Approve is the primary action.
	const decisions = (r: InboxRequest): Act[] =>
		ORDER.flatMap((d) => r.moves.filter((m) => m.decision === d)).map((move) => ({
			label: t(LABEL[move.decision]),
			run: () => choose(r, move),
			variant: move.decision === 'approve' ? 'default' : 'outline'
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
				r.status === 'ChangesRequested'
					? t(
							r.mine
								? 'Changes requested · Your changes are needed'
								: 'Changes requested · Awaiting the requester'
						)
					: t('Pending · {name} (step {step} of {total})')
							.replace('{name}', r.steps[r.step]?.name ?? '')
							.replace('{step}', String(r.step + 1))
							.replace('{total}', String(r.steps.length))
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
				{ field: 'progress', label: t('Status') },
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

<Dialog.Root
	open={chosen !== null}
	onOpenChange={(open) => {
		if (!open && !busy) chosen = null;
	}}
>
	<Dialog.Content
		class={busy ? 'max-w-md [&>button]:hidden' : 'max-w-md'}
		aria-busy={busy}
		onEscapeKeydown={keepWhileBusy}
		onInteractOutside={keepWhileBusy}
	>
		{#if chosen !== null}
			<Dialog.Header>
				<Dialog.Title>{t(LABEL[chosen.move.decision])}</Dialog.Title>
				<Dialog.Description>{t('Add a reason for this decision.')}</Dialog.Description>
			</Dialog.Header>
			<form
				class="flex flex-col gap-3"
				onsubmit={(event) => {
					event.preventDefault();
					const current = chosen;
					if (current !== null) fork(decide(current.request, current.move, reason));
				}}
			>
				<div class="flex flex-col gap-1.5">
					<label for={reasonId} class="text-label">{t('Reason')}</label>
					<Textarea id={reasonId} rows={3} required disabled={busy} bind:value={reason} />
				</div>
				{#if message}<p role="alert" class="text-sm text-destructive">{message}</p>{/if}
				<Dialog.Footer>
					<Button
						type="button"
						variant="ghost"
						disabled={busy}
						onclick={() => {
							chosen = null;
						}}>{t('Cancel')}</Button
					>
					<Button type="submit" disabled={busy || reason.trim() === ''}
						>{t(LABEL[chosen.move.decision])}</Button
					>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
