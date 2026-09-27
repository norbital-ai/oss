<!--
	The shell finder (L-BOLT-497, 512; ⌘/): type to find an app page or a record the viewer may read; Enter opens it. A
	record search waits for a pause in typing, and a stale answer never replaces a newer one. With the agent on, the
	first row asks Norbius the query instead.
-->
<script lang="ts">
	import { watch } from 'runed';
	import { Dialog, Input } from '@norbital-ai/ui';
	import type { Exposure, NavNode } from './nav.ts';
	import { pageHits, recordFinder, type FinderHit, type FinderRead } from './finder.ts';

	let { open = $bindable(false), nav, catalog, read, t, onNavigate, onOpenRecord, onAsk }: {
		open?: boolean; nav: readonly NavNode[]; catalog: { readonly [collection: string]: Exposure }; read: FinderRead;
		t: (key: string) => string; onNavigate: (href: string) => void; onOpenRecord: (collection: string, id: string) => void;
		onAsk: ((prompt: string) => void) | null;
	} = $props();

	const DEBOUNCE_MS = 200;
	// svelte-ignore state_referenced_locally
	const records = recordFinder(catalog, read, t);
	let query = $state('');
	let found = $state<FinderHit[]>([]);
	let searching = $state(false);
	let active = $state(0);
	const pages = $derived(pageHits(nav, query, t).slice(0, 8));
	type Row = FinderHit | { kind: 'ask'; key: 'ask'; label: string };
	const rows = $derived<Row[]>([...(onAsk !== null && query.trim() !== '' ? [{ kind: 'ask' as const, key: 'ask' as const, label: query.trim() }] : []), ...pages, ...found]);

	watch(() => query, (q) => {
		active = 0;
		found = [];
		if (q.trim() === '' || records.collections.length === 0) return void (searching = false);
		searching = true;
		const timer = setTimeout(() => void records.search(q).then((hits) => {
			if (hits === null) return;   // a newer query is on its way
			found = hits;
			searching = false;
		}), DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	function choose(row: Row | undefined): void {
		if (row === undefined) return;
		open = false;
		if (row.kind === 'ask') onAsk?.(row.label);
		else if (row.kind === 'page') onNavigate(row.href);
		else onOpenRecord(row.collection, row.id);
		query = '';
	}
	function keydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			active = (active + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % Math.max(rows.length, 1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			choose(rows[active]);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="top-[20%] max-w-lg translate-y-0 gap-2 p-3">
		<Dialog.Title class="sr-only">{t('Find')}</Dialog.Title>
		<Input autofocus placeholder={t('Find an app or a record…')} aria-label={t('Find')} bind:value={query} onkeydown={keydown}
			role="combobox" aria-expanded={rows.length > 0} aria-controls="shell-finder-results" />
		<ul id="shell-finder-results" role="listbox" aria-label={t('Results')} class="max-h-80 overflow-y-auto text-sm">
			{#each rows as row, i (row.key)}
				<li role="option" aria-selected={i === active}>
					<button type="button" class={['flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left', i === active && 'bg-muted']}
						onmouseenter={() => (active = i)} onclick={() => choose(row)}>
						{#if row.kind === 'ask'}
							<span class="shrink-0 text-muted-foreground">{t('Ask Norbius')}</span><span class="min-w-0 truncate">{row.label}</span>
						{:else}
							<span class="min-w-0 truncate">{row.label}</span>
							{#if row.context}<span class="ml-auto shrink-0 text-meta">{row.context}</span>{/if}
						{/if}
					</button>
				</li>
			{/each}
		</ul>
		{#if searching}<p role="status" class="px-2 text-meta">{t('Searching…')}</p>
		{:else if query.trim() !== '' && rows.length === 0}<p role="status" class="px-2 text-meta">{t('Nothing found.')}</p>{/if}
	</Dialog.Content>
</Dialog.Root>
