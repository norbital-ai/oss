<script lang="ts" module>
	import type { CollectionKey, FieldOf, WhereOf } from '../collection/types.js';
	import type { PivotValue } from './grid.js';
	import type { Toolbar } from '../collection/ViewToolbar.svelte';
	/** The props of `Pivot`, typed by the collection `of`. */
	export type PivotProps<C = CollectionKey> = {
		of: C;
		rows: FieldOf<C>;
		cols?: FieldOf<C>;
		value: PivotValue<FieldOf<C>>;
		where?: WhereOf<C>;
		every?: string;
		/** The chrome (`ViewToolbar`); the filter narrows what is counted. Search, which an aggregate has not, is off. */
		toolbar?: Toolbar;
		key?: string;
	};
</script>

<script lang="ts" generics="C extends CollectionKey">
	// One live aggregate by `[rows, cols]` rendered as a grid with totals.
	import { useBolt } from '../client/context.js';
	import { watch } from '../read/live.svelte.js';
	import { and, compact } from '../filter/scope.js';
	import { label, msg } from '../text/messages.js';
	import { pivotGrid } from './grid.js';
	import { objectsOf } from '../read/results.js';
	import ReadGate from '../read/ReadGate.svelte';
	import { useKinds } from '../kinds/context.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import ViewToolbar from '../collection/ViewToolbar.svelte';

	let { of, rows, cols, value, where, every, toolbar = {}, key }: PivotProps<C> = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const catalog = $derived(kinds.catalog ?? {});
	const view = viewState(bolt, {
		key: () => key ?? of,
		collection: () => of,
		catalog: () => catalog,
		initialFilter: () => undefined
	});
	const agg = watch(() =>
		bolt.live(
			bolt.aggregate(
				of,
				compact({
					by: cols === undefined ? [rows] : [rows, cols],
					...('sum' in value ? { sum: [value.sum] } : { count: true }),
					where: and(where, view.where),
					all: true
				})
			),
			every === undefined ? {} : { every }
		)
	);
	const fmt = (n: number) => new Intl.NumberFormat(bolt.locale).format(n);
</script>

<ViewToolbar config={toolbar} collection={of} {view} {catalog} author={where} />
<ReadGate state={agg.state} what={label(bolt, of)}>
	{#snippet children(v)}
		{@const g = pivotGrid(objectsOf(v), rows, cols, value)}
		{#if g.rowKeys.length === 0}
			<p class="text-muted-foreground p-4 text-sm" data-read="empty">
				{msg(bolt, 'table.none', 'No rows')}
			</p>
		{:else}
			<div class="overflow-x-auto" data-view="pivot">
				<table
					class="text-sm [&_td]:px-2 [&_td]:py-1 [&_td]:text-right [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_tr]:border-b"
				>
					<thead
						><tr
							><th>{label(bolt, of, rows)}</th>{#each g.colKeys as c (c)}<th class="text-right"
									>{c}</th
								>{/each}{#if cols !== undefined}<th class="text-right"
									>{msg(bolt, 'pivot.total', 'Total')}</th
								>{/if}</tr
						></thead
					>
					<tbody>
						{#each g.rowKeys as r (r)}
							<tr
								><th class="font-normal">{r}</th>{#each g.colKeys as c (c)}<td>{fmt(g.at(r, c))}</td
									>{/each}{#if cols !== undefined}<td class="font-medium">{fmt(g.rowTotal(r))}</td
									>{/if}</tr
							>
						{/each}
						<tr class="font-medium"
							><th>{msg(bolt, 'pivot.total', 'Total')}</th>{#each g.colKeys as c (c)}<td
									>{fmt(g.colTotal(c))}</td
								>{/each}{#if cols !== undefined}<td>{fmt(g.total)}</td>{/if}</tr
						>
					</tbody>
				</table>
			</div>
		{/if}
	{/snippet}
</ReadGate>
