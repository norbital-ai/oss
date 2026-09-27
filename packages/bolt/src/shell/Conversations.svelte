<!--
	`/conversations` (§5.9 built-in reads, rule 61): staff browse the envoys' channel conversations, newest first, unread
	ones marked; one conversation shows its whole channel history as it lands, read-only: replies go only through the
	channel. Opening a conversation marks it read (`sys_message.markRead`).
-->
<script lang="ts">
	import { watch } from 'runed';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { Table } from '@norbital-ai/ui';
	import SystemPage from './SystemPage.svelte';
	import type { AgentRow } from '../protocol/wire.ts';
	import type { ShellApi, ShellBolt } from './runtime.ts';

	let { api, bolt, t, id }: { api: ShellApi; bolt: Pick<ShellBolt, 'live'>; t: (key: string) => string; id?: string | undefined } = $props();

	const list = $derived(id === undefined ? api.conversations() : null);
	let rows = $state<AgentRow[]>([]);
	let error = $state<string | null>(null);

	watch(() => id, (c) => {
		if (c === undefined) return;
		void api.agent.markRead(c);
		// the thread's rows are its live transcript: each landed or rewritten message arrives as a patch
		const transcript = bolt.live<{ rows: AgentRow[] }>({ read: { m: 'transcript', a: [c] },
			then: (ok, bad) => Promise.reject<{ rows: AgentRow[] }>(new Error('the transcript is read live')).then(ok, bad) });
		return transcript.subscribe((value) => {
			error = transcript.error?.message ?? error;
			if (value !== undefined) rows = value.rows;
		});
	});
	const when = (at: unknown) => typeof at === 'string' ? new Date(at).toLocaleString() : '';
	/** A row opens its conversation: a URL change the shell follows, as `openRecord`'s. */
	function open(c: string): void {
		history.pushState(history.state, '', `/conversations/${encodeURIComponent(c)}`);
		dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
	}
</script>

{#snippet subject({ row }: { row: { title: string; unread: boolean }; value: unknown })}<span class:font-semibold={row.unread} data-unread={row.unread || undefined}>{row.title}</span>{/snippet}
{#snippet at({ value }: { row: object; value: unknown })}<time class="tabular-nums">{when(value)}</time>{/snippet}

{#if list !== null}
	<SystemPage name="conversations" title={t('Conversations')}>
		{#await list then r}
			{#if !r.ok}
				<p role="alert" class="text-sm text-destructive">{r.error.message}</p>
			{:else}
				<Table of={r.value.map((c) => ({ ...c, title: c.title ?? c.author ?? c.channel, via: c.envoy ?? c.channel }))} key="conversations" onOpen={(c) => open(c.id)}
					columns={[{ field: 'title', label: t('Conversation'), cell: subject }, { field: 'via', label: t('Channel') }, { field: 'preview', label: t('Message') },
						{ field: 'at', label: t('When'), cell: at }, { field: 'unread', label: t('Unread') }]}>
					{#snippet empty()}<p class="text-sm text-muted-foreground">{t('No conversations yet.')}</p>{/snippet}
				</Table>
			{/if}
		{/await}
	</SystemPage>
{:else}
<Stack gap="md" class="p-6">
		<Inline justify="between">
			<a href="/conversations" class="text-sm hover:underline">← {t('Conversations')}</a>
			<span class="text-xs text-muted-foreground" data-read-only>{t('The envoy answers on the channel.')}</span>
		</Inline>
		<ol class="space-y-2 text-sm" aria-live="polite">
			{#each rows as row (row.id)}
				{#if row.text && row.role !== 'tool' && row.role !== 'system'}
					<li class="rounded-md px-3 py-2" class:bg-muted={row.role !== 'assistant'} class:opacity-70={row.tag === 'ambient'} data-role={row.role ?? 'channel'}>
						<p class="text-xs text-muted-foreground">{row.role === 'assistant' ? t('Agent') : row.author ?? t('Unknown sender')}</p>
						<p class="whitespace-pre-wrap">{row.text}</p>
						{#if row.detail}<p class="text-xs text-destructive" data-detail>{row.detail}</p>{/if}
					</li>
				{/if}
			{/each}
		</ol>
		{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</Stack>
{/if}
