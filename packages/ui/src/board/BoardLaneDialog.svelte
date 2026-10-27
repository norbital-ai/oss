<script lang="ts" generics="C extends ModelKey">
	// One lane expanded in the board's dialog: the same cards and pages as a responsive grid, with a search and filter of
	// its own ANDed under the lane's condition (which already carries the board's scope), so it only ever narrows.
	import { onDestroy, untrack } from 'svelte';
	import { watch } from 'runed';
	import type { ModelKey, RowOf } from '../model/types.js';
	import type { Json } from '../client/contract.js';
	import { useBolt } from '../client/context.js';
	import { useKinds } from '../kinds/context.js';
	import * as Dialog from '../primitives/dialog/index.js';
	import { and } from '../filter/scope.js';
	import { orderOf, sortable } from '../filter/filter.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import ViewPopover from '../filter/ViewPopover.svelte';
	import ToolbarSearch from '../model/toolbar/ToolbarSearch.svelte';
	import { msg } from '../text/messages.js';
	import type { BoardProps } from './Board.svelte';
	import BoardLane from './BoardLane.svelte';

	let {
		of,
		card,
		label,
		dot,
		count,
		where,
		orderBy,
		search = '',
		pageSize,
		viewKey,
		selectable,
		selected,
		onSelect,
		onChange,
		onOpen
	}: Pick<BoardProps<C>, 'of' | 'card'> & {
		label: string;
		/** The lane dot's tone class, or null. */
		dot: string | null;
		count: number | null;
		/** The lane's condition under the board's scope: never widened here. */
		where: Json | undefined;
		orderBy: Json | undefined;
		/** The board's search, the box's starting text. */
		search?: string;
		pageSize: number;
		/** The board's URL key; the lane's filter lives under `<key>.lane` while the dialog is open. */
		viewKey: string;
		selectable: boolean;
		selected: ReadonlySet<RowOf<C>['id']>;
		onSelect: (id: RowOf<C>['id'], on: boolean) => void;
		onChange: () => void;
		onOpen: (id: string) => void;
	} = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const catalog = $derived(kinds.catalog ?? {});
	const key = untrack(() => `${viewKey}.lane`);
	const view = viewState(bolt, {
		key: () => key,
		model: () => of,
		catalog: () => catalog,
		initialFilter: () => undefined
	});
	// each opening starts clean: the lane's filter leaves the URL with the dialog
	onDestroy(() => {
		const url = new URL(location.href);
		url.searchParams.delete(`${key}.where`);
		url.searchParams.delete(`${key}.order`);
		history.replaceState(history.state, '', url);
	});
	let q = $state(untrack(() => search)),
		searched = $state(untrack(() => search));
	watch(
		() => q,
		(text) => {
			const timer = setTimeout(() => (searched = text.trim()), 300);
			return () => clearTimeout(timer);
		},
		{ lazy: true }
	);
	const scope = $derived(and(where, view.where));
	const order = $derived(view.order.length > 0 ? orderOf(view.order) : orderBy);
</script>

<Dialog.Header class="pr-8">
	<Dialog.Title class="flex min-w-0 items-center gap-1.5">
		{#if dot}<span class={['size-2 shrink-0 rounded-full', dot]} aria-hidden="true"></span>{/if}
		<span class="truncate">{label}</span>
		{#if count !== null && searched === '' && view.where === undefined}<span
				class="text-muted-foreground text-sm tabular-nums">{count}</span
			>{/if}
	</Dialog.Title>
</Dialog.Header>
<div class="flex min-w-0 flex-wrap items-center gap-1" data-lane-toolbar>
	{#if (catalog[of]?.search?.length ?? 0) > 0}<ToolbarSearch
			bind:value={q}
			label={msg(bolt, 'table.search', 'Search')}
		/>{/if}
	<ViewPopover
		{view}
		{catalog}
		model={of}
		author={where}
		sortable={sortable(catalog[of], true, catalog)}
	/>
</div>
<div class="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1" data-lane-scroll>
	<div
		role="list"
		class="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] content-start gap-3"
		data-lane-grid
	>
		<BoardLane
			{of}
			{card}
			lane={label}
			where={scope}
			orderBy={order}
			search={searched || undefined}
			{pageSize}
			{selectable}
			{selected}
			{onSelect}
			{onChange}
			{onOpen}
			grid
		/>
	</div>
</div>
