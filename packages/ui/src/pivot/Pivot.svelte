<script lang="ts" module>
	import type { ModelKey, FieldOf, WhereOf } from '../model/types.js';
	import type { PivotValue } from './grid.js';
	import type { Toolbar } from '../model/ViewToolbar.svelte';
	/** The props of `Pivot`, typed by the model `of`. */
	export type PivotProps<C = ModelKey> = {
		of: C;
		rows: FieldOf<C>;
		cols?: FieldOf<C>;
		value: PivotValue<FieldOf<C>>;
		where?: WhereOf<C>;
		/** The chrome (`ViewToolbar`); the filter narrows what is counted. Search, which an aggregate has not, is off. */
		toolbar?: Toolbar;
		key?: string;
	};
</script>

<script lang="ts" generics="C extends ModelKey">
	// One live aggregate by `[rows, cols]` rendered as a grid with totals.
	import { useBolt } from '../client/context.js';
	import { and, compact } from '../filter/scope.js';
	import { label, msg } from '../text/messages.js';
	import { pivotGrid } from './grid.js';
	import type { Page, Values } from '../model/types.js';
	import ReadGate from '../read/ReadGate.svelte';
	import { queryState } from '../read/state.js';
	import { useKinds } from '../kinds/context.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import ViewToolbar from '../model/ViewToolbar.svelte';

	let { of, rows, cols, value, where, toolbar = {}, key }: PivotProps<C> = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const catalog = $derived(kinds.catalog ?? {});
	const view = viewState(bolt, {
		key: () => key ?? of,
		model: () => of,
		catalog: () => catalog,
		initialFilter: () => undefined
	});
	const agg = $derived(
		bolt.aggregate<Page<Values>>(
			of,
			compact({
				by: cols === undefined ? [rows] : [rows, cols],
				...('sum' in value ? { sum: [value.sum] } : { count: true }),
				where: and(where, view.where),
				all: true
			})
		)
	);
	const fmt = (n: number) => new Intl.NumberFormat(bolt.locale).format(n);
</script>

<ViewToolbar config={toolbar} model={of} {view} {catalog} author={where} />
<ReadGate state={queryState(agg)} what={label(bolt, of)}>
	{#snippet children(v)}
		{@const g = pivotGrid(v.rows, rows, cols, value)}
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
