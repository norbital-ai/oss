<script lang="ts" generics="C extends ModelKey">
	// One lane: a stack of keyset pages, each its own live view. Scrolling near the lane's end opens the next page (server-side
	// infinite loading); the "Load more" button is the same step for a keyboard or where nothing observes the scroll.
	import { watch } from 'runed';
	import { Button } from '../primitives/button/index.js';
	import type { ModelKey, RowOf } from '../model/types.js';
	import type { Json } from '../client/contract.js';
	import { useBolt } from '../client/context.js';
	import type { BoardProps } from './Board.svelte';
	import BoardPage from './BoardPage.svelte';
	import { msg } from '../text/messages.js';

	let {
		of,
		card,
		lane,
		where,
		orderBy,
		search,
		pageSize,
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
		selectable?: boolean;
		selected?: ReadonlySet<RowOf<C>['id']>;
		onSelect?: (id: RowOf<C>['id'], selected: boolean) => void;
		onRows?: (page: symbol, ids: readonly RowOf<C>['id'][]) => () => void;
		onChange?: () => void;
		/** The expanded lane's grid of cards. */
		grid?: boolean;
		onOpen?: (id: string) => void;
	} = $props();
	const bolt = useBolt();
	let pages = $state<(string | null)[]>([null]);
	let nexts = $state<(string | null)[]>([]);
	// a new filter or sort starts the lane over (cursors are bound to the query, rule 11)
	const query = $derived(JSON.stringify({ of, where, orderBy, search }));
	watch(
		() => query,
		() => {
			pages = [null];
			nexts = [];
		},
		{ lazy: true }
	);
	/** The last page's cursor: null until it has loaded, and at the lane's end. */
	const more = $derived(nexts[pages.length - 1] ?? null);
	const load = () => {
		if (more !== null) pages = [...pages, more];
	};
	// the button mounts once the last page has its cursor; in view (within 240px of the lane's end) it loads the next, and a
	// page too short to fill the lane chains the one after it
	const nearEnd = (el: HTMLElement) => {
		if (typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(es) => {
				if (es.some((e) => e.isIntersecting)) load();
			},
			{ root: el.closest('[data-lane-scroll]'), rootMargin: '0px 0px 240px 0px' }
		);
		io.observe(el);
		return () => io.disconnect();
	};
</script>

{#each pages as after, i (after ?? '')}
	<BoardPage
		{of}
		{card}
		{lane}
		{where}
		{orderBy}
		{search}
		{pageSize}
		{selectable}
		{selected}
		{onSelect}
		{onRows}
		{onChange}
		{grid}
		{onOpen}
		index={i}
		{after}
		onNext={(n) => (nexts[i] = n)}
	/>
{/each}
{#if more !== null}
	<Button
		size="sm"
		variant="ghost"
		class={grid ? 'col-span-full' : undefined}
		onclick={load}
		data-lane-more
		{@attach nearEnd}
		>{msg(bolt, 'board.more', 'Load more')}</Button
	>
{/if}
