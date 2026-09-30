<!--
	The inbox (§3.8 "where it shows", rule 46): open requests the viewer may decide, supersede or withdraw, in ui's
	`Table`. Decisions are `bolt.approvals.*`; the host decides eligibility. Opening a request opens its held record,
	whose Approval tab shows the flow. Notices are the bell's (`Bell.svelte`), not listed here a second time.
-->
<script lang="ts">
	import { watch } from 'runed';
	import { Button, Picker, Table, openRecord } from '@norbital-ai/ui';
	import type { InboxRequest } from './data.ts';
	import type { ShellApi, ShellBolt } from './runtime.ts';
	import type { Act } from './Acts.svelte';
	import Acts from './Acts.svelte';
	import SystemPage from './SystemPage.svelte';
	import { SW } from '../protocol/wire.ts';
	import { based } from './nav.ts';

	/** `onCount`: the requests the viewer may decide, as it changes: the sidebar's badge. */
	let { api, bolt, t, push = null, onCount }: { api: ShellApi; bolt: ShellBolt; t: (key: string) => string; push?: string | null; onCount?: (n: number) => void } = $props();

	let requests = $state<InboxRequest[] | null>(null);
	let message = $state<string | null>(null);
	async function load(): Promise<void> {
		const r = await api.inbox();
		if (r.ok) requests = r.value.requests;
		else message = r.error.message;
	}
	void load();
	type Status = 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED';

	async function decide(r: InboxRequest, status: Status | 'WITHDRAW'): Promise<void> {
		// supersede and request-for-change need a reason; reject does not (rule 46)
		const reason = status === 'SUPERSEDED' || status === 'REQUEST_FOR_CHANGE' ? prompt(t('Reason')) : null;
		if ((status === 'SUPERSEDED' || status === 'REQUEST_FOR_CHANGE') && !reason) return;
		const o = status === 'WITHDRAW' ? await bolt.approvals.withdraw(r.id)
			: await bolt.approvals.process(r.id, { status, ...(reason ? { reason } : {}) });
		message = o.kind === 'refused' ? o.message : o.kind === 'conflict' ? t('This request is no longer pending.') : o.kind === 'unknown' ? t('The outcome is unknown; refresh to see it.') : null;
		await load();
	}
	const decisions = (r: InboxRequest): Act[] => [
		...(r.canDecide ? [{ label: t('Approve'), run: () => decide(r, 'APPROVED'), variant: 'default' as const },
			{ label: t('Request changes'), run: () => decide(r, 'REQUEST_FOR_CHANGE') }, { label: t('Reject'), run: () => decide(r, 'REJECTED') }] : []),
		...(r.canSupersede ? [{ label: t('Supersede'), run: () => decide(r, 'SUPERSEDED') }] : []),
		...(r.mine ? [{ label: t('Withdraw'), run: () => decide(r, 'WITHDRAW') }] : []),
	];
	const requestRows = $derived((requests ?? []).map((r) => ({ ...r, progress: `${r.step + 1}/${r.steps}` })));

	const waiting = $derived(requests === null ? null : requests.filter((r) => r.canDecide).length);
	watch(() => waiting, (n) => { if (n !== null) onCount?.(n); });

	// web push (§5.7): offered when the host has a VAPID key and the browser can take a subscription
	const canPush = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined';
	let pushed = $state<'off' | 'on' | 'denied'>('off');
	async function enablePush(key: string): Promise<void> {
		try {
			const reg = await navigator.serviceWorker.register(based(SW), { scope: based('/') });
			const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
			const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
			const r = await api.push(sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } });
			pushed = r.ok ? 'on' : 'denied';
		} catch {
			pushed = 'denied';
		}
	}
	const when = (v: unknown) => typeof v === 'string' ? new Date(v).toLocaleString(bolt.locale) : '—';
</script>

{#snippet at({ value }: { row: object; value: unknown })}<time class="tabular-nums">{when(value)}</time>{/snippet}
<!-- which record: its own label (a trial's title, a submission's name) through the reviewer's read grant, never an id -->
{#snippet record_({ row }: { row: InboxRequest; value: unknown })}<span class="[&_[data-readonly]]:text-xs"><Picker of={row.collection} value={row.record} onChange={() => {}} readonly /></span>{/snippet}
{#snippet decide_({ row }: { row: InboxRequest; value: unknown })}<Acts acts={decisions(row)} />{/snippet}

<SystemPage name="inbox" title={t('Inbox')} error={message}>
	{#if push !== null && canPush}
		<div class="flex flex-wrap items-center gap-2">
			{#if pushed === 'off'}
				<Button size="sm" variant="outline" onclick={() => enablePush(push)}>{t('Notify me on this device')}</Button>
			{:else}
				<span class="text-meta" role="status">{pushed === 'on' ? t('Notices arrive on this device.') : t('Notifications are blocked here.')}</span>
			{/if}
		</div>
	{/if}
	{#if requests === null}
		<p class="text-sm text-muted-foreground">{t('Loading…')}</p>
	{:else}
		<Table of={requestRows} key="approvals" toolbar={{ title: t('Approvals'), export: true }} onOpen={(r) => openRecord(r.collection, r.record)}
			columns={[{ field: 'record', label: t('Record'), cell: record_ }, { field: 'collection', label: t('Collection') }, { field: 'action', label: t('Action') }, { field: 'progress', label: t('Step') },
				{ field: 'by', label: t('Requested by') }, { field: 'at', label: t('When'), cell: at }, { field: 'id', label: t('Actions'), hide: 'narrow', cell: decide_ }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('Nothing waits on you.')}</p>{/snippet}
		</Table>
	{/if}
</SystemPage>

