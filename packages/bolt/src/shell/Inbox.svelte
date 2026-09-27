<!--
	The inbox (§3.8 "where it shows", rule 46): open requests the viewer may decide, supersede or withdraw, and the
	`inbox` notices addressed to them, each in ui's `Table`. Decisions are `bolt.approvals.*`; the host decides
	eligibility. Opening a request opens its held record, whose Approval tab shows the flow.
-->
<script lang="ts">
	import { watch } from 'runed';
	import { Button, Table, openRecord } from '@norbital-ai/ui';
	import type { InboxRequest, Notice } from './data.ts';
	import type { ShellApi, ShellBolt } from './runtime.ts';
	import type { Act } from './Acts.svelte';
	import Acts from './Acts.svelte';
	import DetailSheet from './DetailSheet.svelte';
	import SystemPage from './SystemPage.svelte';
	import { SW } from '../protocol/wire.ts';
	import { based } from './nav.ts';

	/** `onCount`: what waits on the viewer (decidable requests, unread notices) as it changes: the sidebar's badge. */
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

	// L-BOLT-354: the notices are a live read of the member's own rows: a new notice or a `read_at` change arrives as a
	// patch on the page's live stream. Opening one, or "Mark all read", sets its `read_at`.
	// svelte-ignore state_referenced_locally
	const notices = bolt.live<{ rows: Notice[] }>({ read: { m: 'inbox', a: [] },
		then: (ok, bad) => Promise.reject<{ rows: Notice[] }>(new Error('the inbox is read live')).then(ok, bad) });
	const waiting = $derived(requests === null || $notices === undefined ? null
		: requests.filter((r) => r.canDecide).length + $notices.rows.filter((n) => !n.read).length);
	watch(() => waiting, (n) => { if (n !== null) onCount?.(n); });
	async function markRead(ids: readonly string[]): Promise<void> {
		if (ids.length > 0) await api.markNoticesRead(ids);
	}
	const linkOf = (link: unknown) => typeof link === 'object' && link !== null && 'collection' in link && 'id' in link ? { collection: String(link.collection), id: String(link.id) } : null;
	let notice = $state<Notice | null>(null);
	function openNotice(n: Notice): void {
		if (!n.read) void markRead([n.id]);
		const to = linkOf(n.link);
		if (to !== null) openRecord(to.collection, to.id);
		else notice = n;
	}

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
{#snippet decide_({ row }: { row: InboxRequest; value: unknown })}<Acts acts={decisions(row)} />{/snippet}
{#snippet title({ row }: { row: Notice; value: unknown })}<span class={row.read ? '' : 'font-medium'}>{row.title}{#if !row.read}<span class="sr-only"> · {t('Unread')}</span>{/if}</span>{/snippet}
{#snippet read({ value }: { row: Notice; value: unknown })}{value === true ? '' : t('Unread')}{/snippet}

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
			columns={[{ field: 'collection', label: t('Collection') }, { field: 'action', label: t('Action') }, { field: 'progress', label: t('Step') },
				{ field: 'by', label: t('Requested by') }, { field: 'at', label: t('When'), cell: at }, { field: 'id', label: t('Actions'), hide: 'narrow', cell: decide_ }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('Nothing waits on you.')}</p>{/snippet}
		</Table>
	{/if}
	{#if $notices === undefined}
		{#if notices.error !== undefined}<p role="alert" class="text-sm text-destructive">{notices.error.message}</p>{:else}<p class="text-sm text-muted-foreground">{t('Loading…')}</p>{/if}
	{:else}
		{@const rows = $notices.rows}
		<Table of={rows} key="notices" onOpen={openNotice}
			toolbar={{ title: t('Notices'), actions: [{ label: t('Mark all read'), icon: 'lucide:check-check', run: () => markRead(rows.filter((n) => !n.read).map((n) => n.id)),
				disabled: () => rows.some((n) => !n.read) ? null : t('No unread notices.') }] }}
			columns={[{ field: 'title', label: t('Title'), cell: title }, { field: 'body', label: t('Message') }, { field: 'at', label: t('When'), cell: at },
				{ field: 'read', label: t('Read'), cell: read }]}>
			{#snippet empty()}<p class="text-sm text-muted-foreground">{t('No notices.')}</p>{/snippet}
		</Table>
	{/if}
</SystemPage>

{#if notice !== null}
	<DetailSheet title={notice.title} onClose={() => (notice = null)} fields={[{ label: t('Message'), value: notice.body }, { label: t('When'), value: when(notice.at) }]} />
{/if}
