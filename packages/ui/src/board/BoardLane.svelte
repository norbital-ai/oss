<script lang="ts" module>
	import type { Json, UiContext } from '../client/contract.js';
	import type { ModelKey, RowOf, Values } from '../model/types.js';
	import type { BoardProps } from './Board.svelte';

	/** Props of one kanban lane: its query scope, card shape, selection callbacks and optional expanded grid layout. */
	export type BoardLaneProps<C extends ModelKey> = Pick<BoardProps<C>, 'ctx' | 'of' | 'card'> & {
		/** The lane's label, naming its cards to assistive technology. */
		lane: string;
		/** The lane's condition: the board's filter and this lane's value. */
		where: Json | undefined;
		/** The cards' order within the lane. */
		order_by: Json | undefined;
		/** The board's search text. */
		search?: string;
		/** Cards loaded per page step. */
		page_size: number;
		/** Each card carries a selection checkbox. */
		selectable?: boolean;
		/** The selected cards' ids. */
		selected?: ReadonlySet<RowOf<C>['id']>;
		/** A card's checkbox changed. */
		on_select?: (id: RowOf<C>['id'], selected: boolean) => void;
		/** The lane's loaded cards, keyed by the lane; the answer forgets them when the lane goes. */
		on_rows?: (page: symbol, rows: readonly (RowOf<C> & Values)[]) => () => void;
		/** The lane's live rows changed. */
		on_change?: () => void;
		/** Expanded lane dialog: renders cards in a responsive multi-column grid (non-draggable). */
		grid?: boolean;
		/** Opening a card; default the record sheet. */
		on_open?: (id: string) => void;
		/** The other lanes a card may move to, where a finger cannot drag it. */
		moves?: readonly { label: string; move: (id: string) => void }[];
	};
</script>

<script lang="ts" generics="C extends ModelKey">
	// One lane: a single growing live head (up to LIVE_PAGE_ROWS) plus one-shot cursor tail beyond it,
	// windowed by a single virtual_list per lane (or chunked virtual rows in expanded grid mode).
	// Existing cards stay mounted while additional pages load, eliminating inter-page flicker and
	// quadratic overlapping subscriptions.
	import { Effect, Equal } from 'effect';
	import { untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import ApprovalAccent from '../approval/ApprovalAccent.svelte';
	import { approvalOf, approvalText } from '../approval/row.js';
	import { watch as watchSource } from '../behaviors/index.js';
	import Value from '../cell/Value.svelte';
	import { bolt_of } from '../client/context.js';
	import { observe_once } from '../effect/index.js';
	import { recordText } from '../kinds/kind.js';
	import { Button } from '../primitives/button/index.js';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { virtual_list } from '../primitives/virtual/virtual.svelte.js';
	import { LIVE_PAGE_ROWS } from '../read/paging.js';
	import ReadGate from '../read/ReadGate.svelte';
	import { page_of, request_json } from '../read/request.js';
	import { mapped, queryState, type ReadState } from '../read/state.js';
	import { open_record } from '../record/navigation.js';
	import { label_wave, labelled, listRequest, refOf, unref } from '../relations/select.js';
	import { label, msg } from '../text/messages.js';
	import BoardEmptyLane from './BoardEmptyLane.svelte';

	type CardRow = RowOf<C> & Values;

	let {
		ctx,
		of,
		card,
		where,
		order_by,
		search,
		page_size,
		selectable = false,
		selected,
		on_select,
		on_rows,
		on_change,
		grid = false,
		on_open,
		moves
	}: BoardLaneProps<C> = $props();

	const bolt = $derived(bolt_of(ctx));
	const kinds = $derived(ctx.ui.kinds);
	/** A finger scrolls the lane: a card moves from its menu, not by a drag. */
	const touch = new MediaQuery('pointer: coarse');
	const open = (id: string) => (on_open ? on_open(id) : open_record(of, id));
	const approvalTip = (row: unknown) => {
		const held = approvalOf(row);
		return held === null ? undefined : approvalText(bolt, held);
	};

	const fields = $derived(typeof card === 'function' ? [] : card);
	const readFields = $derived([
		...new Set([
			...fields,
			...(kinds.catalog?.[of]?.record_label === undefined ? [] : (kinds.catalog?.[of]?.label ?? []))
		])
	]);
	const queryScope = $derived(JSON.stringify({ of, where, order_by, search, fields, page_size }));

	let pageCount = $state(1);
	let settledHead = $state.raw<{
		readonly scope: string;
		readonly rows: readonly CardRow[];
		readonly next: string | null;
	} | null>(null);
	let tailChunks = $state.raw<readonly (readonly CardRow[])[]>([]);
	let tailNext = $state<string | null>(null);
	let tailCursor = $state<string | null>(null);
	let tailLoading = $state(false);
	let gridWidth = $state(0);

	// A new filter, sort, search or model starts the lane cleanly from page 1.
	watchSource(
		() => queryScope,
		() => {
			pageCount = 1;
			settledHead = null;
			tailChunks = [];
			tailNext = null;
			tailCursor = null;
			tailLoading = false;
			laneWin.reset();
			gridWin.reset();
		},
		{ lazy: true }
	);

	// One live query covers rows 0..min(pageCount * page_size, LIVE_PAGE_ROWS).
	const liveLimit = $derived(Math.min(pageCount * page_size, LIVE_PAGE_ROWS));
	const headQuery = $derived.by(() => {
		void queryScope;
		const limit = liveLimit;
		return untrack(() =>
			mapped(
				bolt.model_query(
					of,
					request_json(
						listRequest(
							kinds.catalog,
							of,
							{ where, order_by, search: search || undefined, limit },
							readFields
						)
					),
					'list'
				),
				(answer) => page_of(answer, of)
			)
		);
	});
	const headState = $derived(queryState(headQuery));

	watchSource(
		() => ({ scope: queryScope, state: headState }),
		({ scope, state }) => {
			if (state.kind === 'ready') {
				settledHead = {
					scope,
					rows: state.value.rows,
					next: state.value.next
				};
			} else if (state.kind === 'error' || state.kind === 'noAccess') {
				settledHead = null;
			}
		}
	);

	// Notify the board to recount lane totals when live data changes within the same scope & limit.
	watchSource(
		() => ({ scope: queryScope, limit: liveLimit, value: headQuery.current }),
		(current, previous) => {
			if (
				previous?.scope === current.scope &&
				previous.limit === current.limit &&
				previous.value !== undefined &&
				current.value !== undefined &&
				!Equal.equals(previous.value, current.value)
			) {
				on_change?.();
			}
		}
	);

	// Beyond LIVE_PAGE_ROWS, fetch additional pages once by keyset cursor and append into the unified list.
	const tailRead = observe_once(() => {
		const cursor = tailCursor;
		const scope = queryScope;
		if (cursor === null) return null;
		return untrack(() =>
			bolt
				.model_query(
					of,
					request_json(
						listRequest(
							kinds.catalog,
							of,
							{ where, order_by, search: search || undefined, limit: page_size, after: cursor },
							readFields
						)
					),
					'list'
				)
				.pipe(Effect.map((answer) => ({ scope, cursor, page: page_of(answer, of) })))
		);
	});

	watchSource(
		() => ({ current: tailRead.current, error: tailRead.error }),
		({ current, error }) => {
			if (current !== undefined && current.scope === queryScope && current.cursor === tailCursor) {
				if (current.page !== undefined) {
					tailChunks = [...tailChunks, current.page.rows];
					tailNext = current.page.next;
				} else {
					tailNext = null;
				}
				tailLoading = false;
				tailCursor = null;
			} else if (error !== undefined && tailCursor !== null) {
				tailLoading = false;
				tailCursor = null;
			}
		}
	);

	const activeHead = $derived(
		headState.kind === 'ready'
			? headState.value
			: settledHead !== null && settledHead.scope === queryScope
				? settledHead
				: null
	);
	const loadingMore = $derived(
		(headState.kind === 'loading' &&
			settledHead !== null &&
			settledHead.scope === queryScope) ||
			tailLoading
	);
	const displayState: ReadState<readonly CardRow[]> = $derived(
		activeHead !== null
			? { kind: 'ready', value: activeHead.rows }
			: headState.kind === 'ready'
				? { kind: 'ready', value: headState.value.rows }
				: headState
	);
	const more = $derived(
		tailChunks.length > 0 || tailLoading ? tailNext : (activeHead?.next ?? null)
	);

	const cards = $derived.by(() => {
		const seen = new Set<string>();
		const out: CardRow[] = [];
		const push = (rows: readonly CardRow[]) => {
			for (const row of rows) {
				if (typeof row.id !== 'string' || row.id.trim() === '' || seen.has(row.id)) continue;
				seen.add(row.id);
				out.push(row);
			}
		};
		if (activeHead !== null) push(activeHead.rows);
		for (const chunk of tailChunks) push(chunk);
		return out;
	});

	// One label wave for unexpanded relation fields across the lane.
	const labelRequest = $derived(label_wave(kinds.catalog, of, fields, cards));
	const labels = $derived(labelRequest === null ? null : bolt.query(labelRequest));
	const presented = $derived(
		fields.length === 0
			? null
			: new Map<string, Values>(
					cards.map<[string, Values]>((row) => [
						row.id,
						labelled(
							kinds.catalog,
							of,
							fields,
							unref(kinds.catalog, of, fields, [row]),
							labels?.current
						)[0] ?? row
					])
				)
	);

	const lanePageKey = Symbol();
	const reportRows = () => on_rows?.(lanePageKey, cards);

	const load = () => {
		if (more === null || loadingMore) return;
		if (pageCount * page_size < LIVE_PAGE_ROWS) {
			pageCount += 1;
		} else {
			tailLoading = true;
			tailCursor = more;
		}
	};

	const prefetchThreshold = $derived(Math.max(8, Math.ceil(page_size * 0.6)));
	const laneWin = virtual_list({
		count: () => (grid ? 0 : cards.length),
		key: (i) => cards[i]?.id ?? String(i),
		estimate: 76,
		gap: 8,
		threshold: 25,
		overscan: 6,
		on_range: (range) => {
			if (!grid && range.scrolled && more !== null && !loadingMore && range.remaining <= prefetchThreshold) {
				load();
			}
		}
	});

	// Expanded dialog grid: virtualize into horizontal rows when card count exceeds threshold and container width is measured.
	const GRID_VIRTUAL_THRESHOLD = 36;
	const GRID_MIN_CARD_PX = 256;
	const GRID_GAP_PX = 12;
	const virtualGridOn = $derived(grid && cards.length > GRID_VIRTUAL_THRESHOLD && gridWidth > 0);
	const gridCols = $derived(
		virtualGridOn
			? Math.max(1, Math.floor((gridWidth + GRID_GAP_PX) / (GRID_MIN_CARD_PX + GRID_GAP_PX)))
			: 1
	);
	const gridRows = $derived.by<readonly (readonly CardRow[])[]>(() => {
		if (!virtualGridOn) return [];
		const out: CardRow[][] = [];
		for (let i = 0; i < cards.length; i += gridCols) {
			out.push(cards.slice(i, i + gridCols));
		}
		return out;
	});
	const gridWin = virtual_list({
		count: () => gridRows.length,
		key: (r) => gridRows[r]?.[0]?.id ?? String(r),
		estimate: 108,
		gap: GRID_GAP_PX,
		threshold: 0,
		overscan: 5,
		on_range: (range) => {
			if (virtualGridOn && range.scrolled && more !== null && !loadingMore && range.remaining <= 4) {
				load();
			}
		}
	});

	const measureGridParent = (el: HTMLElement) => {
		if (!grid || typeof ResizeObserver === 'undefined') return;
		const parent = el.parentElement;
		if (parent === null) return;
		const syncWidth = () => {
			const w = parent.clientWidth;
			if (w > 0 && w !== gridWidth) gridWidth = w;
		};
		syncWidth();
		const ro = new ResizeObserver(syncWidth);
		ro.observe(parent);
		return () => ro.disconnect();
	};

	// Generous 600px prefetch margin so fast scrolling triggers the next page well before hitting the bottom.
	const nearEnd = (el: HTMLElement) => {
		if (typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) load();
			},
			{ root: el.closest('[data-lane-scroll]'), rootMargin: '0px 0px 600px 0px' }
		);
		io.observe(el);
		return () => io.disconnect();
	};
</script>

{#snippet cardItem(row: CardRow, attachMeasure: boolean)}
	{@const displayed = presented?.get(row.id) ?? row}
	<!-- not a <button>: a card snippet's own buttons and links must receive their clicks; the card opens on the rest -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		role="listitem"
		tabindex="0"
		draggable={grid || touch.current ? undefined : 'true'}
		{@attach attachMeasure ? laneWin.measure(row.id) : () => {}}
		class={[
			'group bg-surface-raised text-card-foreground hover:border-border-control data-[dragging]:opacity-40 relative flex w-full cursor-pointer flex-col gap-1 overflow-clip rounded-control border text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
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
				e.target.closest('button, input, select, textarea, [contenteditable], [role=checkbox]')
			) {
				e.preventDefault();
				return;
			}
			e.dataTransfer?.setData('text/x-bolt-id', row.id);
		}}
		onclick={(e) => {
			// only a control inside the card counts: the sheet or the expanded lane it sits in is a dialog too
			const own =
				e.target instanceof Element
					? e.target.closest(
							'a, button, input, select, textarea, label, summary, [contenteditable], [role=button], [role=checkbox], [role=dialog]'
						)
					: null;
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
						<Button variant="ghost" onclick={() => target.move(row.id)}>{target.label}</Button>
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
						>{:else}<Value
							{ctx}
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
{/snippet}

<span hidden {@attach reportRows} {@attach measureGridParent}></span>
<ReadGate {ctx} state={displayState} what={label(bolt, of)}>
	{#snippet skeleton()}
		<div class={grid ? 'col-span-full grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-3' : 'flex flex-col gap-2'}>
			{#each [0, 1, 2] as i (i)}
				<div class="bg-card flex h-20 flex-col gap-2 rounded-sm border p-2.5">
					<div class="bg-muted h-3.5 w-3/4 animate-pulse rounded motion-reduce:animate-none"></div>
					<div class="bg-muted h-3 w-1/2 animate-pulse rounded motion-reduce:animate-none"></div>
				</div>
			{/each}
		</div>
	{/snippet}
	{#snippet children()}
		{#if cards.length === 0}
			<BoardEmptyLane {ctx} {grid} />
		{:else if virtualGridOn}
			<div class="col-span-full -mb-3 flex flex-col">
				<div aria-hidden="true" style:height="{gridWin.before}px" {@attach gridWin.anchor}></div>
				{#each gridWin.slice(gridRows) as rowGroup (rowGroup[0]?.id ?? '')}
					<div
						class="mb-3 grid gap-3"
						style:grid-template-columns="repeat({gridCols}, minmax(0, 1fr))"
						{@attach gridWin.measure(rowGroup[0]?.id ?? '')}
					>
						{#each rowGroup as row (row.id)}
							{@render cardItem(row, false)}
						{/each}
					</div>
				{/each}
				{#if gridWin.after > 0}
					<div aria-hidden="true" style:height="{gridWin.after}px"></div>
				{/if}
			</div>
		{:else if grid}
			<div class="contents">
				{#each cards as row (row.id)}
					{@render cardItem(row, false)}
				{/each}
			</div>
		{:else}
			<div class={['flex flex-col', cards.length > 0 && '-mb-2']}>
				{#if laneWin.on}<div
						aria-hidden="true"
						style:height="{laneWin.before}px"
						{@attach laneWin.anchor}
					></div>{/if}
				{#each laneWin.slice(cards) as row (row.id)}
					{@render cardItem(row, laneWin.on)}
				{/each}
				{#if laneWin.on && laneWin.after > 0}<div
						aria-hidden="true"
						style:height="{laneWin.after}px"
					></div>{/if}
			</div>
		{/if}
		{#if more !== null}
			<Button
				variant="ghost"
				class={grid ? 'col-span-full' : undefined}
				disabled={loadingMore}
				aria-busy={loadingMore || undefined}
				onclick={load}
				data-lane-more
				{@attach nearEnd}>{msg(bolt, 'board.more')}</Button
			>
		{/if}
	{/snippet}
</ReadGate>
