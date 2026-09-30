<script lang="ts">
	import type { Json, Row } from './bolt.js';
	import { useKinds } from '../kinds/context.js';
	import { virtualList } from '../primitives/virtual/virtual.svelte.js';
	import { openRecord, useBolt } from './bolt.js';
	import type { BoardProps } from './Board.svelte';
	import { watch } from './live.svelte.js';
	import { compact, label, listSelect, msg, nextOf, pageRead, refOf, rowsOf, unref } from './model.js';
	import Glyph from './Glyph.svelte';
	import ReadGate from './ReadGate.svelte';
	import Value from './Value.svelte';

	let { of, card, where, orderBy, search, pageSize, index, after, onNext }: Pick<BoardProps, 'of' | 'card'> & { lane: string;
		where: Json | undefined; orderBy: Json | undefined; search?: string; pageSize: number; index: number; after: string | null; onNext: (next: string | null) => void } = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const fields = $derived(typeof card === 'function' ? [] : card as readonly string[]);
	const page = watch(() => pageRead(bolt, (limit, at) => bolt.read(of, compact({ where, orderBy, search, select: listSelect(kinds.catalog, of, fields), limit, after: at })), pageSize, index, after)); // hook:agent-ui — later pages stay live
	$effect(() => { if (page.state.kind === 'ready') onNext(nextOf(page.state.value)); });
	const cards = $derived(page.state.kind === 'ready' ? unref(kinds.catalog, of, fields, rowsOf(page.state.value), bolt.locale) : []);
	// every loaded page of a lane windows alone (threshold 0): a lane opened ten pages deep keeps a screen of cards mounted
	const lane = virtualList({ count: () => cards.length, key: (i) => String(cards[i]?.['id']), estimate: 72, threshold: 0, overscan: 4 });
</script>

<ReadGate state={page.state} what={label(bolt, of)}>
	{#snippet skeleton()}
		<div class="flex flex-col gap-2">
			{#each [0, 1, 2] as i (i)}
				<div class="bg-card flex h-20 flex-col gap-2 rounded-sm border p-2.5">
					<div class="bg-muted h-3.5 w-3/4 animate-pulse rounded motion-reduce:animate-none"></div>
					<div class="bg-muted h-3 w-1/2 animate-pulse rounded motion-reduce:animate-none"></div>
				</div>
			{/each}
		</div>
	{/snippet}
	{#snippet children()}
		{#if index === 0 && cards.length === 0}
			<!-- an empty lane is still a drop target: the placeholder keeps a card's height so one can land here -->
			<div class="border-border bg-background/50 flex min-h-28 flex-col items-center justify-center gap-1 rounded-sm border border-dashed p-4 text-center" data-lane-empty>
				<Glyph name="inbox" class="text-muted-foreground size-5" />
				<p class="text-sm font-medium">{msg(bolt, 'board.laneEmpty', 'Nothing here')}</p>
				<p class="text-meta">{msg(bolt, 'board.laneClear', 'Lane clear')}</p>
			</div>
		{/if}
		<!-- the cards' spacing is their margin (measured with them); the page gives the last one back to the lane's gap -->
		<div class={['flex flex-col', cards.length > 0 && '-mb-2']}>
		<div aria-hidden="true" style="height:{lane.before}px" {@attach lane.anchor}></div>
		{#each lane.slice(cards) as row (row['id'])}
			<!-- not a <button>: a card snippet's own buttons and links must receive their clicks; the card opens on the rest -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<div role="listitem" tabindex="0" draggable="true" {@attach lane.measure(String(row['id']))} class="group bg-card shadow-card hover:border-input relative mb-2 flex w-full cursor-pointer flex-col gap-1 overflow-clip rounded-sm border p-2.5 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				ondragstart={(e) => e.dataTransfer?.setData('text/x-bolt-id', String(row['id']))}
				onclick={(e) => { if (!(e.target as Element).closest('a, button, input, select, textarea, label, [role=button]') && typeof row['id'] === 'string') openRecord(of, row['id']); }}
				onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && typeof row['id'] === 'string') { e.preventDefault(); openRecord(of, row['id']); } }}>
				{#if typeof row['approval_id'] === 'string'}<span class="bg-brand absolute inset-y-1 left-0 w-1 rounded-r-full" title={msg(bolt, 'record.pending', 'Pending review')} aria-hidden="true"></span>{/if}
				<!-- the drag handle (staging's): the whole card drags; the grip says so where a pointer hovers -->
				<span class="border-border bg-background/95 text-muted-foreground pointer-events-none absolute top-1.5 right-1.5 grid size-6 cursor-grab place-items-center rounded-sm border opacity-0 shadow-xs transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none" aria-hidden="true"><Glyph name="grip" class="size-3.5" /></span>
				{#if typeof card === 'function'}{@render card({ row: row as Row })}
				{:else}
					{#each fields as f, i (f)}<span class={i === 0 ? 'font-medium' : 'text-muted-foreground text-xs'}><Value value={row[f]} kind={kinds.catalog?.[of]?.fields[f]} {row} ref={refOf(row, f)} name={f} dense /></span>{/each}
				{/if}
			</div>
		{/each}
		{#if lane.after > 0}<div aria-hidden="true" style="height:{lane.after}px"></div>{/if}
		</div>
	{/snippet}
</ReadGate>
