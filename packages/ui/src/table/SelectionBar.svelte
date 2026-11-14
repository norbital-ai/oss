<!--
@component
A view's selection line: the page's checkbox (a card list has no header), then the selected count, "select every
matching row" and clear; with nothing selected, the range.
-->
<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import { words_of } from '../client/context.js';
	import { Button } from '../primitives/button/index.js';
	import { msg } from '../text/messages.js';

	let {
		ctx,
		count,
		all,
		matching = null,
		busy = false,
		range,
		on_page,
		on_matching,
		on_clear
	}: {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The rows selected. */
		count: number;
		/** Every row of the page is selected. */
		all: boolean;
		/** The rows the view matches, when known: past the selection, they may all be selected. */
		matching?: number | null;
		/** Selecting every matching row is under way. */
		busy?: boolean;
		/** The rows shown ("1–25 of 80"), said while none are selected. */
		range: string;
		/** The page's checkbox: select or clear every row of the page. */
		on_page: (selected: boolean) => void;
		/** Select every matching row. */
		on_matching: () => void;
		/** Clear the selection. */
		on_clear: () => void;
	} = $props();
	const text = $derived(words_of(ctx));
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1" data-selection>
	<label class="inline-flex items-center gap-2 md:hidden">
		<input
			type="checkbox"
			checked={all}
			aria-label={msg(text, 'table.selectPage')}
			onchange={(e) => on_page(e.currentTarget.checked)}
			data-select-page
		/>
		{msg(text, 'table.selectPage')}
	</label>
	{#if count > 0}
		<span class="font-medium" data-selected-count>{msg(text, 'table.selected', { n: count })}</span>
		{#if all && matching !== null && matching > count}
			<Button
				variant="link"
				class="h-auto px-0 text-xs"
				disabled={busy}
				onclick={on_matching}
				data-select-matching
			>
				{msg(text, 'table.selectMatching', { n: matching })}</Button
			>
		{/if}
		<Button variant="link" class="h-auto px-0 text-xs" onclick={on_clear} data-select-clear
			>{msg(text, 'table.clearSelection')}</Button
		>
	{:else}<span class="tabular-nums" data-range>{range}</span>{/if}
</div>
