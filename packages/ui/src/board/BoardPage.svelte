<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { ModelKey, RowOf, Values } from '../model/types.js';
	import type { Json } from '../client/contract.js';
	import type { BoardProps } from './Board.svelte';

	export type BoardPageProps<C extends ModelKey> = Pick<BoardProps<C>, 'ctx' | 'of' | 'card'> & {
		lane: string;
		where: Json | undefined;
		order_by: Json | undefined;
		search?: string;
		page_size: number;
		index: number;
		after: string | null;
		on_next: (next: string | null) => void;
		selectable?: boolean;
		selected?: ReadonlySet<RowOf<C>['id']>;
		on_select?: (id: RowOf<C>['id'], selected: boolean) => void;
		on_rows?: (page: symbol, rows: readonly (RowOf<C> & Values)[]) => () => void;
		on_change?: () => void;
		/** The expanded lane: cards are items of the parent's grid, unwindowed (pages bound them) and not draggable. */
		grid?: boolean;
		/** Opening a card; default the record sheet. */
		on_open?: (id: string) => void;
		/** The other lanes a card may move to, where a finger cannot drag it. */
		moves?: readonly { label: string; move: (id: string) => void }[];
	};
</script>

<script lang="ts" generics="C extends ModelKey">
	import { watch as watchSource } from 'runed';
	import { Equal } from 'effect';
	import { untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { virtual_list } from '../primitives/virtual/virtual.svelte.js';
	import { Button } from '../primitives/button/index.js';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { open_record } from '../record/navigation.js';
	import { bolt_of } from '../client/context.js';
	import { label, msg } from '../text/messages.js';
	import { listRequest, refOf, unref } from '../relations/select.js';
	import { request_json } from '../read/request.js';
	import { pageRead } from '../read/paging.js';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import ReadGate from '../read/ReadGate.svelte';
	import { queryState } from '../read/state.js';
	import Value from '../cell/Value.svelte';
	import { recordText } from '../kinds/kind.js';
	import ApprovalAccent from '../approval/ApprovalAccent.svelte';
	import { approvalOf, approvalText } from '../approval/row.js';

	let {
		ctx,
		of,
		card,
		where,
		order_by,
		search,
		page_size,
		index,
		after,
		on_next,
		selectable = false,
		selected,
		on_select,
		on_rows,
		on_change,
		grid = false,
		on_open,
		moves
	}: BoardPageProps<C> = $props();
	const bolt = $derived(bolt_of(ctx));
	/** A finger scrolls the lane: a card moves from its menu, not by a drag. */
	const touch = new MediaQuery('pointer: coarse');
	const open = (id: string) => (on_open ? on_open(id) : open_record(of, id));
	const approvalTip = (row: unknown) => {
		const held = approvalOf(row);
		return held === null ? undefined : approvalText(bolt, held);
	};
	const kinds = $derived(ctx.ui.kinds);
	const fields = $derived(typeof card === 'function' ? [] : card);
	const readFields = $derived([
		...new Set([
			...fields,
			...(kinds.catalog?.[of]?.record_label === undefined ? [] : (kinds.catalog?.[of]?.label ?? []))
		])
	]);
	const query = $derived(
		JSON.stringify({ of, where, order_by, search, fields, page_size, index, after })
	);
	// hook:agent-ui — later pages stay live
	const page = $derived.by(() => {
		// Count metadata can rebuild an equivalent lane filter; keep its existing query and pages.
		void query;
		return untrack(() =>
			pageRead(
				of,
				(limit, at) =>
					bolt.model_query(
						of,
						request_json(
							listRequest(
								kinds.catalog,
								of,
								{ where, order_by, search: search || undefined, limit, after: at },
								readFields
							)
						),
						'list'
					),
				page_size,
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
				!Equal.equals(previous.value, current.value)
			)
				on_change?.();
		}
	);
	watchSource(() => ({ state, on_next }), ({ state, on_next }) => {
		if (state.kind === 'ready') on_next(state.value.next);
	});
	const cards = $derived(
		state.kind === 'ready'
			? state.value.rows.filter((row) => typeof row.id === 'string' && row.id.trim() !== '')
			: []
	);
	const pageKey = Symbol();
	const reportRows = () =>
		on_rows?.(
			pageKey,
			cards
		);
	// every loaded page of a lane windows alone (threshold 0): a lane opened ten pages deep keeps a screen of cards mounted
	const lane = virtual_list({
		count: () => cards.length,
		key: (i) => cards[i]?.id ?? String(i),
		estimate: 72,
		threshold: 0,
		overscan: 4
	});
</script>

<span hidden {@attach reportRows}></span>
<ReadGate {ctx} {state} what={label(bolt, of)}>
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
			<!-- an empty lane remains a drop target -->
			<div
				class={[
					'flex min-h-28 flex-col items-center justify-center gap-1 rounded-sm border border-transparent p-4 text-center dark:border-border dark:border-dashed dark:bg-background/50',
					grid && 'col-span-full'
				]}
				data-lane-empty
			>
				<Glyph name="inbox" class="text-muted-foreground mb-1 size-5 dark:mb-0" />
				<p class="text-sm text-muted-foreground dark:font-medium dark:text-foreground">
					{msg(bolt, 'board.laneEmpty')}
				</p>
				<p class="text-meta hidden dark:block">{msg(bolt, 'board.laneClear')}</p>
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
				{@const displayed = unref(kinds.catalog, of, fields, [row])[0] ?? row}
				<!-- not a <button>: a card snippet's own buttons and links must receive their clicks; the card opens on the rest -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					role="listitem"
					tabindex="0"
					draggable={grid || touch.current ? undefined : 'true'}
					{@attach lane.measure(row.id)}
					class={[
						'group bg-popover text-popover-foreground hover:border-input data-[dragging]:opacity-40 relative flex w-full cursor-pointer flex-col gap-1 overflow-clip rounded-sm border text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:bg-card dark:text-card-foreground',
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
					<ApprovalAccent {ctx} {row} />
					{#if touch.current && moves !== undefined && moves.length > 0}
						<Popover.Root>
							<Popover.Trigger
								class="text-muted-foreground absolute top-0.5 right-0.5 grid size-8 place-items-center rounded-sm [--hit-target:2rem]"
								aria-label={msg(bolt, 'board.moveTo')}
								data-card-move={row.id}><Glyph name="more" class="size-4" /></Popover.Trigger
							>
							<Popover.Content
								align="end"
								class="flex w-auto min-w-40 flex-col gap-0.5 p-1.5 [&>button]:justify-start"
							>
								{#each moves as target (target.label)}
									<Button variant="ghost" onclick={() => target.move(row.id)}>{target.label}</Button
									>
								{/each}
							</Popover.Content>
						</Popover.Root>
					{:else if !grid && !touch.current}
						<!-- the drag handle : the whole card drags; the grip says so where a pointer hovers -->
						<span
							class="border-border bg-background/95 text-muted-foreground pointer-events-none absolute top-1.5 right-1.5 grid size-6 cursor-grab place-items-center rounded-sm border opacity-0 shadow-xs transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
							aria-hidden="true"><Glyph name="grip" class="size-3.5" /></span
						>
					{/if}
					{#if selectable}
						<label class="absolute top-0 left-0 grid size-10 place-items-center max-sm:size-11">
							<Checkbox
								aria-label={msg(bolt, 'table.select')}
								checked={selected?.has(row.id) ?? false}
								on_checked_change={(on) => on_select?.(row.id, on)}
								data-select-row={row.id}
							/>
						</label>
					{/if}
					{#if typeof card === 'function'}{@render card({ row })}
					{:else}
						{#each fields as f, i (f)}<span
								class={i === 0 ? 'font-medium' : 'text-muted-foreground text-xs'}
								>{#if i === 0 && (kinds.catalog?.[of]?.record_label !== undefined || typeof row['$label'] === 'string' || kinds.catalog?.[of]?.label.length === 0) && recordText(kinds.catalog?.[of], row)}<span
										data-record-label>{recordText(kinds.catalog?.[of], row)}</span
									>{:else}<Value {ctx}
										value={displayed[f]}
										kind={kinds.catalog?.[of]?.fields[f]}
										row={displayed}
										ref={refOf(displayed, f)}
										name={f}
										dense
										link={false}
									/>{/if}</span
							>{/each}
					{/if}
				</div>
			{/each}
			{#if !grid && lane.after > 0}<div aria-hidden="true" style="height:{lane.after}px"></div>{/if}
		</div>
	{/snippet}
</ReadGate>
