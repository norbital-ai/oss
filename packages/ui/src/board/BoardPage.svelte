<script lang="ts" generics="C extends ModelKey">
	import type { ModelKey, Row, RowOf } from '../model/types.js';
	import type { Json, QueryAnswer } from '../client/contract.js';
	import { watch as watchSource } from 'runed';
	import { untrack } from 'svelte';
	import { useKinds } from '../kinds/context.js';
	import { virtualList } from '../primitives/virtual/virtual.svelte.js';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import { openRecord } from '../record/navigation.js';
	import { useBolt } from '../client/context.js';
	import type { BoardProps } from './Board.svelte';
	import { label, msg } from '../text/messages.js';
	import { listRequest, refOf, unref } from '../relations/select.js';
	import { requestJson } from '../read/request.js';
	import { pageRead } from '../read/paging.js';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import ReadGate from '../read/ReadGate.svelte';
	import { queryState } from '../read/state.js';
	import Value from '../cell/Value.svelte';
	import ApprovalAccent from '../approval/ApprovalAccent.svelte';
	import { approvalOf, approvalText } from '../approval/row.js';

	let {
		of,
		card,
		where,
		orderBy,
		search,
		pageSize,
		index,
		after,
		onNext,
		selectable = false,
		selected,
		onSelect,
		onRows,
		onChange,
		grid = false,
		onOpen
	}: Pick<BoardProps<C>, 'of' | 'card'> & {
		lane: string;
		where: Json | undefined;
		orderBy: Json | undefined;
		search?: string;
		pageSize: number;
		index: number;
		after: string | null;
		onNext: (next: string | null) => void;
		selectable?: boolean;
		selected?: ReadonlySet<RowOf<C>['id']>;
		onSelect?: (id: RowOf<C>['id'], selected: boolean) => void;
		onRows?: (page: symbol, ids: readonly RowOf<C>['id'][]) => () => void;
		onChange?: () => void;
		/** The expanded lane: cards are items of the parent's grid, unwindowed (pages bound them) and not draggable. */
		grid?: boolean;
		/** Opening a card; default the record sheet. */
		onOpen?: (id: string) => void;
	} = $props();
	const bolt = useBolt();
	const open = (id: string) => (onOpen ? onOpen(id) : openRecord(of, id));
	const approvalTip = (row: unknown) => {
		const held = approvalOf(row);
		return held === null ? undefined : approvalText(bolt, held);
	};
	const kinds = useKinds();
	const fields = $derived(typeof card === 'function' ? [] : card);
	const query = $derived(
		JSON.stringify({ of, where, orderBy, search, fields, pageSize, index, after })
	);
	// hook:agent-ui — later pages stay live
	const page = $derived.by(() => {
		// Count metadata can rebuild an equivalent lane filter; keep its existing query and pages.
		void query;
		return untrack(() =>
			pageRead(
				of,
				(limit, at) =>
					bolt.query<QueryAnswer<RowOf<C> & Row>>(
						requestJson(
							listRequest(
								kinds.catalog,
								of,
								{ where, orderBy, search: search || undefined, limit, after: at },
								fields
							)
						)
					),
				pageSize,
				index,
				after
			)
		);
	});
	const state = $derived(queryState(page));
	watchSource(
		() => ({ query, value: page.current }),
		(current, previous) => {
			if (
				previous?.query === current.query &&
				previous.value !== undefined &&
				current.value !== undefined &&
				previous.value !== current.value
			)
				onChange?.();
		}
	);
	$effect(() => {
		if (state.kind === 'ready') onNext(state.value.next);
	});
	const cards = $derived(
		state.kind === 'ready'
			? state.value.rows.filter((row) => typeof row.id === 'string' && row.id.trim() !== '')
			: []
	);
	const pageKey = Symbol();
	const reportRows = () =>
		onRows?.(
			pageKey,
			cards.map((row) => row.id)
		);
	// every loaded page of a lane windows alone (threshold 0): a lane opened ten pages deep keeps a screen of cards mounted
	const lane = virtualList({
		count: () => cards.length,
		key: (i) => cards[i]?.id ?? String(i),
		estimate: 72,
		threshold: 0,
		overscan: 4
	});
</script>

<span hidden {@attach reportRows}></span>
<ReadGate {state} what={label(bolt, of)}>
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
			<div
				class={[
					'border-border bg-background/50 flex min-h-28 flex-col items-center justify-center gap-1 rounded-sm border border-dashed p-4 text-center',
					grid && 'col-span-full'
				]}
				data-lane-empty
			>
				<Glyph name="inbox" class="text-muted-foreground size-5" />
				<p class="text-sm font-medium">{msg(bolt, 'board.laneEmpty', 'Nothing here')}</p>
				<p class="text-meta">{msg(bolt, 'board.laneClear', 'Lane clear')}</p>
			</div>
		{/if}
		<!-- the cards' spacing is their margin (measured with them); the page gives the last one back to the lane's gap -->
		<div class={grid ? 'contents' : ['flex flex-col', cards.length > 0 && '-mb-2']}>
			{#if !grid}<div
					aria-hidden="true"
					style="height:{lane.before}px"
					{@attach lane.anchor}
				></div>{/if}
			{#each grid ? cards : lane.slice(cards) as row (row['id'])}
				{@const displayed = unref(kinds.catalog, of, fields, [row], bolt.locale)[0] ?? row}
				<!-- not a <button>: a card snippet's own buttons and links must receive their clicks; the card opens on the rest -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					role="listitem"
					tabindex="0"
					draggable={grid ? undefined : 'true'}
					{@attach lane.measure(row.id)}
					class={[
						'group bg-card shadow-card hover:border-input data-[dragging]:opacity-40 relative flex w-full cursor-pointer flex-col gap-1 overflow-clip rounded-sm border text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
						grid ? 'min-h-24 p-3' : 'mb-2 p-2.5',
						selectable && 'pl-12',
						selected?.has(row.id) && 'border-primary bg-accent/40'
					]}
					data-board-card={row.id}
					title={approvalTip(row)}
					data-selected={selected?.has(row.id) || undefined}
					ondragstart={(e) => {
						if (
							e.target instanceof Element &&
							e.target !== e.currentTarget &&
							e.target.closest(
								'button, input, select, textarea, [contenteditable], [role=checkbox]'
							)
						) {
							e.preventDefault();
							return;
						}
						e.dataTransfer?.setData('text/x-bolt-id', row.id);
					}}
					onclick={(e) => {
						// only a control inside the card counts: the sheet or the expanded lane it sits in is a dialog too
						const own = (e.target as Element).closest(
							'a, button, input, select, textarea, label, summary, [contenteditable], [role=button], [role=checkbox], [role=dialog]'
						);
						if (
							(own === null || !e.currentTarget.contains(own)) &&
							!window.getSelection()?.toString() &&
							typeof row['id'] === 'string'
						)
							open(row['id']);
					}}
					onkeydown={(e) => {
						if (
							e.target === e.currentTarget &&
							(e.key === 'Enter' || e.key === ' ') &&
							typeof row['id'] === 'string'
						) {
							e.preventDefault();
							open(row['id']);
						}
					}}
				>
					<ApprovalAccent {row} />
					{#if !grid}
						<!-- the drag handle : the whole card drags; the grip says so where a pointer hovers -->
						<span
							class="border-border bg-background/95 text-muted-foreground pointer-events-none absolute top-1.5 right-1.5 grid size-6 cursor-grab place-items-center rounded-sm border opacity-0 shadow-xs transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
							aria-hidden="true"><Glyph name="grip" class="size-3.5" /></span
						>
					{/if}
					{#if selectable}
						<label class="absolute top-0.5 left-0.5 grid size-10 place-items-center max-sm:size-11">
							<Checkbox
								aria-label={msg(bolt, 'table.select', 'Select')}
								checked={selected?.has(row.id) ?? false}
								onCheckedChange={(on) => onSelect?.(row.id, on)}
								data-select-row={row.id}
							/>
						</label>
					{/if}
					{#if typeof card === 'function'}{@render card({ row })}
					{:else}
						{#each fields as f, i (f)}<span
								class={i === 0 ? 'font-medium' : 'text-muted-foreground text-xs'}
								><Value
									value={displayed[f]}
									kind={kinds.catalog?.[of]?.fields[f]}
									row={displayed}
									ref={refOf(displayed, f)}
									name={f}
									dense
									link={i !== 0}
								/></span
							>{/each}
					{/if}
				</div>
			{/each}
			{#if !grid && lane.after > 0}<div aria-hidden="true" style="height:{lane.after}px"></div>{/if}
		</div>
	{/snippet}
</ReadGate>
