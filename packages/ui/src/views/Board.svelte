<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { CollectionKey, FieldOf, Json, OrderByOf, RecordFieldOf, RowOf, WhereOf } from './bolt.js';
	import type { Toolbar } from './ViewToolbar.svelte';

	/** A lane: its `by` value (for a relation, the target id), a label, and for a relation its `Where` (default `eq`). */
	export type Lane = Json | { value: Json; label: string; where?: Json };
	/** The props of `Board`, typed by the collection `of`. */
	export type BoardProps<C = CollectionKey, F = FieldOf<C>, K = RecordFieldOf<C>> = {
		of: C;
		/** The lane field: a `state`, an `enum` or a relation. */
		by: F;
		/** At most four fields (a heavy one is then read), or a snippet (final-ui I7). */
		card: readonly [] | readonly [K] | readonly [K, K] | readonly [K, K, K] | readonly [K, K, K, K] | Snippet<[{ row: RowOf<C> }]>;
		/** Required for a relation `by`; otherwise the lanes the aggregate finds, in value order. */
		lanes?: readonly Lane[];
		/**
		 * Lanes per row. Unset is the horizontal reel, which scrolls sideways; a count lays the lanes
		 * out in a grid of that many columns whose rows share the board's height.
		 */
		columns?: number;
		/** The author's fixed scope (never clearable); the viewer's filter is ANDed under it. */
		where?: WhereOf<C>;
		/** Seed rows of the view popover the viewer may edit or clear. */
		initialFilter?: WhereOf<C>;
		/** The cards' order within each lane; a viewer's sort replaces it (lane order stays the lanes'). */
		orderBy?: OrderByOf<C>;
		pageSize?: number;
		/** The chrome (`ViewToolbar`): title, description, search, filter and sort (a sort orders the cards within each lane), actions, New. */
		toolbar?: Toolbar<RowOf<C>>;
		/** The URL parameter prefix; defaults to `of`. */
		key?: string;
	};
</script>

<script lang="ts">
	// Each lane loads infinitely: live keyset pages read by its lane condition, the next one as the lane scrolls near its end
	// (final-ui rule 9); lane counts are one aggregate. A drop is one generated `update` of `by`,
	// painted optimistically and rolled back by a refusal, which shows on the board.
	import { useKinds } from '../kinds/context.js';
	import { tone } from '../kinds/kind.js';
	import { provideCollection, useBolt, useEnumText } from './bolt.js';
	import { orderOf, sortable } from './filter.js';
	import { and, compact, failed, flat, isRow, label, listSelect, lowerLead, msg, rowsOf, show, type ReadState } from './model.js';
	import { notify } from './notify.js';
	import { viewState } from './view-state.svelte.js';
	import ViewToolbar from './ViewToolbar.svelte';
	import BoardLane from './BoardLane.svelte';
	import ReadGate from './ReadGate.svelte';
	import EmptyState from './EmptyState.svelte';

	let { of, by, card, lanes, columns, where, initialFilter, orderBy, pageSize = 25, toolbar = {}, key }: BoardProps = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	provideCollection(() => of);
	const words = useEnumText();
	// a lane of an enum or state value is named in its words
	const laneText = (v: Json) => typeof v === 'string' && ['enum', 'state'].includes(kinds.catalog?.[of]?.fields[by]?.kind ?? '') ? words(v, by) : show(v, bolt.locale);
	const catalog = $derived(kinds.catalog ?? {});
	const view = viewState(bolt, { key: () => key ?? of, collection: () => of, catalog: () => catalog, initialFilter: () => initialFilter });
	const scope = $derived(and(where, view.where));
	const order = $derived(view.order.length > 0 ? orderOf(view.order) : orderBy as Json | undefined);
	// the search is the lanes' (aggregate counts have none, so a searching board hides them)
	let q = $state(''), search = $state('');
	$effect(() => { const t = q; const timer = setTimeout(() => (search = t.trim()), 300); return () => clearTimeout(timer); });
	const fields = $derived(typeof card === 'function' ? [] : card as readonly string[]);
	const exporter = $derived({ fields, labels: fields.map((f) => label(bolt, of, f)),
		read: () => bolt.read(of, compact({ where: scope, orderBy: order, search: search || undefined, select: listSelect(kinds.catalog, of, fields), all: true })) });

	// lane values and counts: one aggregate by `by` (the one-shot count rule 7 applies per lane)
	let found = $state<ReadState<{ value: Json; label: string; where?: Json; count: number | null }[]>>({ kind: 'loading' });
	$effect(() => {
		const given = lanes;
		const w = scope;
		bolt.aggregate(of, { by: [by], count: true, all: true, ...(w === undefined ? {} : { where: w }) }).then((rows) => {
			const counts = new Map(rowsOf(rows).map(flat).map((r) => [JSON.stringify(r[by] ?? null), Number(r['count'] ?? 0)]));
			const list = given === undefined
				? [...counts.keys()].map((k) => ({ value: JSON.parse(k) as Json, label: '' }))
				: given.map((l) => isRow(l) && 'value' in l && typeof l['label'] === 'string' ? { value: l['value'] as Json, label: l['label'], ...(l['where'] === undefined ? {} : { where: l['where'] }) } : { value: l, label: '' });
			found = { kind: 'ready', value: list.map((l) => ({ ...l, label: l.label || laneText(l.value) || msg(bolt, 'board.none', 'None'), count: counts.get(JSON.stringify(l.value)) ?? 0 })) };
		}, (e) => (found = failed(e)));
	});

	async function drop(event: DragEvent, lane: Json) {
		event.preventDefault();
		const id = event.dataTransfer?.getData('text/x-bolt-id');
		if (!id) return;
		const o = await bolt.act(`${of}.update`, { target: id, set: { [by]: lane } });
		if (o.kind !== 'committed') notify(bolt, o);
	}
	// a lane's dot: a state or enum value's tone (the badge's colour); a relation's lanes have none
	const DOT = { neutral: 'bg-muted-foreground/60', info: 'bg-info', success: 'bg-success', warning: 'bg-warning', danger: 'bg-destructive' } as const;
	const byKind = $derived(catalog[of]?.fields[by]?.kind);
	const dotOf = (v: Json) => (byKind === 'state' || byKind === 'enum') && typeof v === 'string' ? DOT[tone(v)] : null;
	// dragging a card near the board's edge snaps the board one lane over (staging's Sortable `scroll`), at most every 450 ms
	let snapped = 0;
	function edgeScroll(e: DragEvent) {
		e.preventDefault();
		const el = e.currentTarget as HTMLElement, r = el.getBoundingClientRect(), EDGE = 80;
		const dir = e.clientX < r.left + EDGE ? -1 : e.clientX > r.right - EDGE ? 1 : 0;
		if (dir === 0 || e.timeStamp - snapped < 450) return;
		snapped = e.timeStamp;
		el.scrollBy({ left: dir * 300, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
	}
</script>

<!-- like Table: fills a bounded parent; each lane scrolls inside itself, the board never grows its parent -->
<section class="@container flex h-full min-w-0 flex-1 flex-col gap-2" data-view="board">
	<ViewToolbar config={toolbar} collection={of} {view} {catalog} author={where} sortable={sortable(catalog[of], true, catalog)} bind:q
		searchable={(catalog[of]?.search?.length ?? 0) > 0} {exporter} />
	<ReadGate state={found} what={label(bolt, of)}>
		{#snippet skeleton()}
			<div class="flex gap-3 overflow-hidden pb-2">
				{#each [3, 2, 4] as n, i (i)}
					<div class="bg-muted/40 flex w-72 shrink-0 flex-col gap-2 rounded-sm p-3">
						<div class="bg-muted h-4 w-24 animate-pulse rounded motion-reduce:animate-none"></div>
						{#each { length: n } as _, j (j)}<div class="bg-card h-20 animate-pulse rounded-sm border motion-reduce:animate-none"></div>{/each}
					</div>
				{/each}
			</div>
		{/snippet}
		{#snippet children(list)}
			{#if list.length === 0}
				<EmptyState variant="card" title={msg(bolt, 'table.empty', 'No {what} yet', { what: lowerLead(label(bolt, of)) })} />
			{:else}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class={columns === undefined
					? 'flex max-h-[calc(100dvh-8rem)] min-h-72 flex-1 snap-x gap-3 overflow-x-auto pb-2'
					: 'grid max-h-[calc(100dvh-8rem)] min-h-72 flex-1 auto-rows-fr gap-3 overflow-y-auto pb-2'}
				style={columns === undefined ? undefined : `grid-template-columns: repeat(${columns}, minmax(0, 1fr))`}
				ondragover={edgeScroll}>
				{#each list as lane (JSON.stringify(lane.value))}
					{@const dot = dotOf(lane.value)}
					<div role="list" class={['bg-muted/40 flex min-h-0 flex-col gap-2 rounded-sm p-3', columns === undefined ? 'w-72 shrink-0 snap-start' : 'min-w-0']} data-lane={JSON.stringify(lane.value)}
						ondragover={(e) => e.preventDefault()} ondrop={(e) => drop(e, lane.value)}>
						<header class="flex items-center justify-between gap-2 text-sm font-medium">
							<span class="flex min-w-0 items-center gap-1.5">{#if dot}<span class={['size-2 shrink-0 rounded-full', dot]} aria-hidden="true"></span>{/if}<span class="truncate">{lane.label}</span></span>
							{#if search === ''}<span class="text-muted-foreground text-xs tabular-nums">{lane.count}</span>{/if}
						</header>
						<div class="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1" data-lane-scroll>
							<BoardLane {of} {card} lane={lane.label} orderBy={order} search={search || undefined} {pageSize} where={and(scope, lane.where ?? { [by]: lane.value === null ? { isNull: true } : { eq: lane.value } })} />
						</div>
					</div>
				{/each}
			</div>
			{/if}
		{/snippet}
	</ReadGate>
</section>
