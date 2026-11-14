<!--
@component
A column heading's menu: pin or unpin, hide, move left or right, reset its width, and show a hidden column again.
-->
<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import { words_of } from '../client/context.js';
	import Glyph, { type GlyphName } from '../primitives/icon/Glyph.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { msg } from '../text/messages.js';

	let {
		ctx,
		field,
		label,
		pinned,
		first,
		last,
		only,
		resized,
		hidden,
		on_pin,
		on_hide,
		on_move,
		on_reset_width,
		on_show
	}: {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The column's field. */
		field: string;
		/** The column's heading. */
		label: string;
		/** The column is pinned to the left. */
		pinned: boolean;
		/** The first column: it cannot move left. */
		first: boolean;
		/** The last column: it cannot move right. */
		last: boolean;
		/** The only column shown: it cannot be hidden. */
		only: boolean;
		/** The viewer set its width. */
		resized: boolean;
		/** The hidden columns, to show again. */
		hidden: readonly { readonly field: string; readonly label: string }[];
		/** Pin or unpin the column. */
		on_pin: () => void;
		/** Hide the column. */
		on_hide: () => void;
		/** Move the column one place left (`-1`) or right (`1`). */
		on_move: (by: -1 | 1) => void;
		/** Drop the viewer's width for the column. */
		on_reset_width: () => void;
		/** Show the hidden column `field` again. */
		on_show: (field: string) => void;
	} = $props();
	const text = $derived(words_of(ctx));
</script>

{#snippet item(label: string, glyph: GlyphName, onclick: () => void, off = false)}
	<button
		type="button"
		class="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left disabled:opacity-40"
		disabled={off}
		{onclick}
	>
		<Glyph name={glyph} class="text-muted-foreground size-3.5 shrink-0" />{label}
	</button>
{/snippet}

<Popover.Root>
	<Popover.Trigger
		class="text-muted-foreground hover:bg-background hover:text-foreground ml-auto grid size-6 shrink-0 place-items-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
		aria-label={msg(text, 'table.columnMenu', { column: label })}
		data-column-menu={field}><Glyph name="more" class="size-3.5" /></Popover.Trigger
	>
	<Popover.Content align="start" class="flex w-52 flex-col gap-0.5 p-1.5 text-xs font-normal">
		{@render item(msg(text, pinned ? 'table.unpin' : 'table.pin'), 'pin', on_pin)}
		{@render item(msg(text, 'table.hideColumn'), 'eyeOff', on_hide, only)}
		{@render item(msg(text, 'table.moveLeft'), 'left', () => on_move(-1), first)}
		{@render item(msg(text, 'table.moveRight'), 'right', () => on_move(1), last)}
		{#if resized}{@render item(msg(text, 'table.resetWidth'), 'sync', on_reset_width)}{/if}
		{#if hidden.length > 0}
			<p class="text-muted-foreground mt-1 border-t px-2 pt-2 pb-1 font-medium">
				{msg(text, 'table.hiddenColumns')}
			</p>
			{#each hidden as h (h.field)}{@render item(h.label, 'eye', () => on_show(h.field))}{/each}
		{/if}
	</Popover.Content>
</Popover.Root>
