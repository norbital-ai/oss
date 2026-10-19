<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type {
		CollectionKey,
		FieldOf,
		OrderByOf,
		Page,
		RecordFieldOf,
		RowOf,
		WhereOf
	} from '../collection/types.js';
	import type { Json } from '../client/contract.js';
	import type { Toolbar, ToolbarItem } from '../collection/ViewToolbar.svelte';

	/** A lane: its `by` value (for a relation, the target id), a label, and for a relation its `Where` (default `eq`). */
	export type Lane =
		| import('@norbital-ai/std/kind').Value
		| { value: import('@norbital-ai/std/kind').Value; label: string; where?: Json };
	/** The props of `Board`, typed by the collection `of`. */
	export type BoardProps<C = CollectionKey, F = FieldOf<C>, K = RecordFieldOf<C>> = {
		of: C;
		/** The lane field: a `state`, an `enum` or a relation. */
		by: F;
		/** At most four fields (a heavy one is then read), or a snippet (final-ui I7). */
		card:
			| readonly []
			| readonly [K]
			| readonly [K, K]
			| readonly [K, K, K]
			| readonly [K, K, K, K]
			| Snippet<[{ row: RowOf<C> }]>;
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

<script lang="ts" generics="C extends CollectionKey">
	import { formatValue as show } from '../kinds/kind.js';
	import { Effect, Schedule, Stream } from 'effect';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { encodeWire } from '@norbital-ai/std/wire';
	import { fork } from '../effect/index.js';
	import { Button } from '../primitives/button/index.js';
	import { Checkbox } from '../primitives/checkbox/index.js';
	import { watch as watchRead } from '../read/live.svelte.js';
	// Each lane loads infinitely: live keyset pages read by its lane condition, the next one as the lane scrolls near its end
	// (final-ui rule 9); lane counts are one aggregate. A drop is one generated `update` of `by`,
	// painted optimistically and rolled back by a refusal, which shows on the board.
	import { useKinds } from '../kinds/context.js';
	import { watch } from 'runed';
	import { tone } from '../kinds/kind.js';
	import { provideCollection, useEnumText } from '../collection/context.js';
	import { useBolt } from '../client/context.js';
	import { orderOf, sortable } from '../filter/filter.js';
	import { actOutcome } from '../actions/outcome.js';
	import { and, compact } from '../filter/scope.js';
	import { COUNT_EVERY_MS } from '../read/paging.js';
	import { flat } from '../read/aggregate.js';
	import { isRow, objectsOf } from '../read/results.js';
	import { label, lowerLead, msg } from '../text/messages.js';
	import { listSelect } from '../relations/select.js';
	import { type ReadState } from '../read/state.js';
	import { notify } from '../actions/notify.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import ViewToolbar, { selectionEnabled } from '../collection/ViewToolbar.svelte';
	import BoardLane from './BoardLane.svelte';
	import ReadGate from '../read/ReadGate.svelte';
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';

	let {
		of,
		by,
		card,
		lanes,
		columns,
		where,
		initialFilter,
		orderBy,
		pageSize = 25,
		toolbar = {},
		key
	}: BoardProps<C> = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	provideCollection(() => of);
	const words = useEnumText();
	// a lane of an enum or state value is named in its words
	const laneText = (v: import('@norbital-ai/std/kind').Value) =>
		typeof v === 'string' && ['enum', 'state'].includes(kinds.catalog?.[of]?.fields[by]?.kind ?? '')
			? words(v, by)
			: show(v, bolt.locale);
	const catalog = $derived(kinds.catalog ?? {});
	const selectable = $derived(selectionEnabled(toolbar, catalog[of]));
	const view = viewState(bolt, {
		key: () => key ?? of,
		collection: () => of,
		catalog: () => catalog,
		initialFilter: () => initialFilter
	});
	const scope = $derived(and(where, view.where));
	const order = $derived(view.order.length > 0 ? orderOf(view.order) : orderBy);
	// the search is the lanes' (aggregate counts have none, so a searching board hides them)
	let q = $state(''),
		search = $state('');
	type SelectedId = RowOf<C>['id'] & Parameters<ToolbarItem<RowOf<C>>['run']>[0][number];
	const recordId = (id: RowOf<C>['id']): id is SelectedId =>
		typeof id === 'string' && id.trim() !== '';
	const selected = new SvelteSet<SelectedId>();
	const loaded = new SvelteMap<symbol, readonly SelectedId[]>();
	const loadedIds = $derived([...new Set([...loaded.values()].flat())]);
	const loadedAll = $derived(loadedIds.length > 0 && loadedIds.every((id) => selected.has(id)));
	const loadedSome = $derived(loadedIds.some((id) => selected.has(id)));
	let selecting = $state(false);
	let selectionNotice = $state('');
	let selectionRevision = 0;
	const clearSelection = () => {
		selectionRevision++;
		selected.clear();
		selecting = false;
		selectionNotice = '';
	};
	const toggle = (id: SelectedId, on: boolean) => {
		if (selecting) {
			selectionRevision++;
			selecting = false;
		}
		selectionNotice = '';
		on ? selected.add(id) : selected.delete(id);
	};
	const toggleLoaded = (on: boolean) => {
		for (const id of loadedIds) toggle(id, on);
	};
	const registerRows = (page: symbol, ids: readonly RowOf<C>['id'][]) => {
		loaded.set(page, ids.filter(recordId));
		return () => loaded.delete(page);
	};
	const selectionScope = $derived(JSON.stringify({ of, by, where: scope, order, search, lanes }));
	watch(() => [selectionScope, q, selectable], clearSelection, { lazy: true });
	$effect(() => {
		const t = q;
		const timer = setTimeout(() => (search = t.trim()), 300);
		return () => clearTimeout(timer);
	});
	const fields = $derived(typeof card === 'function' ? [] : card);
	const exporter = $derived({
		fields,
		labels: fields.map((f) => label(bolt, of, f)),
		read: () =>
			bolt.read(
				of,
				compact({
					where: scope,
					orderBy: order,
					search: search || undefined,
					select: listSelect(kinds.catalog, of, fields, fields, true),
					all: true
				})
			)
	});

	// lane values and counts: one aggregate by `by` (the one-shot count rule 7 applies per lane)
	let countsInvalid = $state(false);
	let countsRevision = 0;
	const countsRead = watchRead(() => {
		const collection = of,
			field = by,
			where = scope;
		let cached: unknown,
			first = true;
		const read = Effect.suspend(() => {
			if (!first && !countsInvalid) return Effect.succeed(cached);
			const revision = countsRevision;
			return bolt
				.aggregate(collection, {
					by: [field],
					count: true,
					all: true,
					...(where === undefined ? {} : { where })
				})
				.pipe(
					Effect.tap((answer) =>
						Effect.sync(() => {
							cached = answer;
							first = false;
							countsInvalid = revision !== countsRevision;
						})
					)
				);
		});
		return Stream.fromEffectSchedule(read, Schedule.spaced(COUNT_EVERY_MS));
	});
	const found = $derived.by<
		ReadState<
			{
				value: import('@norbital-ai/std/kind').Value;
				label: string;
				where?: Json;
				count: number | null;
			}[]
		>
	>(() => {
		if (countsRead.state.kind !== 'ready') return countsRead.state;
		const rows = objectsOf(countsRead.state.value).map(flat);
		const counts = new Map(
			rows.map((row) => [JSON.stringify(row[by] ?? null), Number(String(row['count'] ?? 0))])
		);
		const configured = (
			lane: Lane
		): lane is {
			value: import('@norbital-ai/std/kind').Value;
			label: string;
			where?: Json;
		} => isRow(lane) && 'value' in lane && typeof lane['label'] === 'string';
		const list =
			lanes === undefined
				? rows.map((row) => ({ value: row[by] ?? null, label: '' }))
				: lanes.map((lane) =>
						configured(lane)
							? {
									value: lane['value'],
									label: lane['label'],
									...(lane['where'] === undefined ? {} : { where: lane['where'] })
								}
							: { value: lane, label: '' }
					);
		return {
			kind: 'ready',
			value: list.map((lane) => ({
				...lane,
				label: lane.label || laneText(lane.value) || msg(bolt, 'board.none', 'None'),
				count: countsInvalid ? null : (counts.get(JSON.stringify(lane.value)) ?? 0)
			}))
		};
	});
	const matching = $derived(
		search === '' &&
			found.kind === 'ready' &&
			found.value.every((lane) => lane.count !== null) &&
			!lanes?.some((lane) => isRow(lane) && lane['where'] !== undefined)
			? found.value.reduce((total, lane) => total + (lane.count ?? 0), 0)
			: null
	);
	function selectMatching() {
		if (selecting || found.kind !== 'ready') return;
		const revision = selectionRevision;
		const current = selectionScope;
		const queryText = q;
		// Authored lanes can hide records outside the board, including through a relation's custom condition.
		const laneScope: Json | undefined =
			lanes === undefined
				? undefined
				: {
						or: found.value.map(
							(lane): Json =>
								lane.where ?? {
									[by]: lane.value === null ? { isNull: true } : { eq: encodeWire(lane.value) }
								}
						)
					};
		selecting = true;
		selectionNotice = '';
		fork(
			bolt
				.read<Page<Pick<RowOf<C>, 'id'>>>(
					of,
					compact({
						where: and(scope, laneScope),
						search: search || undefined,
						select: { id: true },
						all: true
					})
				)
				.pipe(
					Effect.tap((answer) =>
						Effect.sync(() => {
							if (revision !== selectionRevision || current !== selectionScope || queryText !== q)
								return;
							for (const row of answer.rows) if (recordId(row.id)) selected.add(row.id);
						})
					),
					Effect.catch((error) =>
						Effect.sync(() => {
							if (revision === selectionRevision && current === selectionScope && queryText === q)
								selectionNotice = error.message;
						})
					),
					Effect.ensuring(
						Effect.sync(() => {
							if (revision === selectionRevision && current === selectionScope && queryText === q)
								selecting = false;
						})
					)
				)
		);
	}
	const invalidateCounts = () => {
		countsRevision++;
		countsInvalid = true;
	};

	watch(
		() => search,
		(current, previous) => {
			if (current === '' && previous !== undefined && previous !== '') invalidateCounts();
		}
	);

	// the drag in flight: the card being dragged (cloned as the target lane's placeholder), its lane, and the lane under the pointer
	let dragged = $state<{ card: HTMLElement; from: string } | null>(null);
	let over = $state<string | null>(null);
	function dragStart(e: DragEvent) {
		if (e.defaultPrevented) return;
		const el = (e.target as Element).closest<HTMLElement>('[draggable=true]'),
			from = el?.closest<HTMLElement>('[data-lane]')?.dataset['lane'];
		if (!el || from === undefined) return;
		dragged = { card: el, from };
		// dimmed after the browser has taken its drag image
		requestAnimationFrame(() => {
			if (dragged?.card === el) el.dataset['dragging'] = '';
		});
	}
	function dragEnd() {
		if (dragged) delete dragged.card.dataset['dragging'];
		dragged = null;
		over = null;
	}
	const placeholder = (host: HTMLElement) => {
		if (!dragged) return;
		const copy = dragged.card.cloneNode(true) as HTMLElement;
		copy.removeAttribute('draggable');
		copy.removeAttribute('tabindex');
		copy.removeAttribute('role');
		delete copy.dataset['dragging'];
		host.replaceChildren(copy);
	};

	function drop(event: DragEvent, lane: import('@norbital-ai/std/kind').Value) {
		event.preventDefault();
		dragEnd();
		const id = event.dataTransfer?.getData('text/x-bolt-id');
		if (!id) return;
		fork(
			actOutcome(bolt.act(`${of}.update`, { target: id, set: { [by]: lane } })).pipe(
				Effect.tap((outcome) =>
					Effect.sync(() => {
						if (outcome.kind !== 'committed') notify(bolt, outcome);
					})
				)
			)
		);
	}
	// a lane's dot: a state or enum value's tone (the badge's colour); a relation's lanes have none
	const DOT = {
		neutral: 'bg-muted-foreground/60',
		info: 'bg-info',
		success: 'bg-success',
		warning: 'bg-warning',
		danger: 'bg-destructive'
	} as const;
	const byKind = $derived(catalog[of]?.fields[by]?.kind);
	const dotOf = (v: import('@norbital-ai/std/kind').Value) =>
		(byKind === 'state' || byKind === 'enum') && typeof v === 'string' ? DOT[tone(v)] : null;
	// dragging a card near the board's edge snaps the board one lane over , at most every 450 ms
	let snapped = 0;
	function edgeScroll(e: DragEvent) {
		e.preventDefault();
		const el = e.currentTarget as HTMLElement,
			r = el.getBoundingClientRect(),
			EDGE = 80;
		const dir = e.clientX < r.left + EDGE ? -1 : e.clientX > r.right - EDGE ? 1 : 0;
		if (dir === 0 || e.timeStamp - snapped < 450) return;
		snapped = e.timeStamp;
		el.scrollBy({
			left: dir * 300,
			behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
		});
	}
</script>

<!-- like Table: fills a bounded parent; each lane scrolls inside itself, the board never grows its parent -->
<section class="@container flex h-full min-w-0 flex-1 flex-col gap-2" data-view="board">
	<ViewToolbar
		config={toolbar}
		collection={of}
		{view}
		{catalog}
		author={where}
		sortable={sortable(catalog[of], true, catalog)}
		bind:q
		searchable={(catalog[of]?.search?.length ?? 0) > 0}
		selected={selectable ? [...selected] : undefined}
		onSettled={clearSelection}
		{exporter}
	/>
	{#if selectable}
		<div
			class="bg-muted/40 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-sm px-3 py-1.5 text-xs"
			data-selection
		>
			<label class="inline-flex min-h-8 items-center gap-2">
				<Checkbox
					checked={loadedAll}
					indeterminate={loadedSome && !loadedAll}
					disabled={loadedIds.length === 0}
					aria-label={msg(bolt, 'table.selectPage', 'Select this page')}
					onCheckedChange={toggleLoaded}
					data-select-page
				/>
				{msg(bolt, 'table.selectPage', 'Select this page')}
			</label>
			{#if selected.size > 0}
				<span class="font-medium" aria-live="polite" data-selected-count
					>{msg(bolt, 'table.selected', '{n} selected', { n: selected.size })}</span
				>
				{#if loadedAll && (matching === null || matching > selected.size)}
					<Button
						variant="link"
						size="sm"
						class="h-auto px-0 text-xs"
						disabled={selecting}
						aria-busy={selecting}
						onclick={selectMatching}
						data-select-matching
					>
						{matching === null
							? msg(bolt, 'table.selectAll', 'Select all')
							: msg(bolt, 'table.selectMatching', 'Select all {n} matching', { n: matching })}
					</Button>
				{/if}
				<Button
					variant="link"
					size="sm"
					class="h-auto px-0 text-xs"
					onclick={clearSelection}
					data-select-clear>{msg(bolt, 'table.clearSelection', 'Clear selection')}</Button
				>
			{/if}
		</div>
		{#if selectionNotice}<p role="alert" class="text-destructive text-xs" data-select-error>
				{selectionNotice}
			</p>{/if}
	{/if}
	{#key selectionScope}
		<ReadGate state={found} what={label(bolt, of)}>
			{#snippet skeleton()}
				<div class="flex gap-3 overflow-hidden pb-2">
					{#each [3, 2, 4] as n, i (i)}
						<div class="bg-muted/40 flex w-72 shrink-0 flex-col gap-2 rounded-sm p-3">
							<div class="bg-muted h-4 w-24 animate-pulse rounded motion-reduce:animate-none"></div>
							{#each { length: n } as _, j (j)}<div
									class="bg-card h-20 animate-pulse rounded-sm border motion-reduce:animate-none"
								></div>{/each}
						</div>
					{/each}
				</div>
			{/snippet}
			{#snippet children(list)}
				{#if list.length === 0}
					<EmptyState
						variant="card"
						title={msg(bolt, 'table.empty', 'No {what} yet', { what: lowerLead(label(bolt, of)) })}
					/>
				{:else}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class={columns === undefined
							? 'flex max-h-[calc(100dvh-8rem)] min-h-72 flex-1 snap-x gap-3 overflow-x-auto pb-2'
							: 'grid max-h-[calc(100dvh-8rem)] min-h-72 flex-1 auto-rows-fr gap-3 overflow-y-auto pb-2'}
						style={columns === undefined
							? undefined
							: `grid-template-columns: repeat(${columns}, minmax(0, 1fr))`}
						ondragover={edgeScroll}
						ondragstart={dragStart}
						ondragend={dragEnd}
					>
						{#each list as lane (JSON.stringify(lane.value))}
							{@const dot = dotOf(lane.value)}
							{@const laneKey = JSON.stringify(lane.value)}
							{@const target = dragged !== null && over === laneKey && dragged.from !== laneKey}
							<div
								role="list"
								class={[
									'flex min-h-0 flex-col gap-2 rounded-sm p-3 ring-inset transition-colors motion-reduce:transition-none',
									target ? 'bg-primary/10 ring-primary/50 ring-2' : 'bg-muted/40',
									columns === undefined ? 'w-72 shrink-0 snap-start' : 'min-w-0'
								]}
								data-lane={laneKey}
								data-drop-target={target || undefined}
								ondragover={(e) => {
									e.preventDefault();
									over = laneKey;
								}}
								ondragleave={(e) => {
									if (over === laneKey && !e.currentTarget.contains(e.relatedTarget as Node | null))
										over = null;
								}}
								ondrop={(e) => drop(e, lane.value)}
							>
								<header class="flex items-center justify-between gap-2 text-sm font-medium">
									<span class="flex min-w-0 items-center gap-1.5"
										>{#if dot}<span class={['size-2 shrink-0 rounded-full', dot]} aria-hidden="true"
											></span>{/if}<span class="truncate">{lane.label}</span></span
									>
									{#if search === ''}<span class="text-muted-foreground text-xs tabular-nums"
											>{lane.count}</span
										>{/if}
								</header>
								<div
									class="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1"
									data-lane-scroll
								>
									{#if target}<div
											class="pointer-events-none -mb-2 opacity-50 saturate-50"
											aria-hidden="true"
											data-drop-placeholder
											{@attach placeholder}
										></div>{/if}
									<BoardLane
										{of}
										{card}
										{selectable}
										{selected}
										onSelect={(id, on) => {
											if (recordId(id)) toggle(id, on);
										}}
										onRows={registerRows}
										lane={lane.label}
										orderBy={order}
										search={search || undefined}
										{pageSize}
										where={and(
											scope,
											lane.where ?? {
												[by]:
													lane.value === null ? { isNull: true } : { eq: encodeWire(lane.value) }
											}
										)}
										onChange={() => invalidateCounts()}
									/>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{/snippet}
		</ReadGate>
	{/key}
</section>
