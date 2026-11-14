<!--
@component
A row as a phone card: its title, then up to three fields (all of them when it opens nothing). The whole card opens the
record; it is not a `<button>`, so a row's own controls inside keep their tap.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		opens,
		title,
		fields,
		value,
		on_press,
		on_open
	}: {
		/** Whether the card opens a record. */
		opens: boolean;
		/** The card's title line. */
		title?: Snippet;
		/** The fields after the title, in order, each with its label. */
		fields: readonly { readonly field: string; readonly label: string }[];
		/** A field's value. */
		value: Snippet<[string]>;
		/** A press anywhere on the card (a link or control inside handles its own). */
		on_press: (event: MouseEvent) => void;
		/** Enter or Space on the focused card. */
		on_open: () => void;
	} = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
<div
	role={opens ? 'button' : undefined}
	tabindex={opens ? 0 : undefined}
	class="flex min-w-0 flex-1 cursor-pointer flex-col text-left"
	data-row-card
	onclick={on_press}
	onkeydown={(e) => {
		if (opens && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			on_open();
		}
	}}
>
	{#if title}<span class="truncate text-sm font-medium">{@render title()}</span>{/if}
	{#if fields.length > 0}
		<div
			class="text-muted-foreground flex flex-wrap gap-x-3 text-xs leading-5 [&_[data-enum-list]]:flex-nowrap [&_[data-enum-value]]:h-auto [&_[data-enum-value]]:border-0 [&_[data-enum-value]]:bg-transparent [&_[data-enum-value]]:p-0 [&_[data-enum-value]]:font-normal"
		>
			{#each opens ? fields.slice(0, 3) : fields as c (c.field)}
				<span class="inline-flex max-w-full min-w-0 items-baseline gap-1 whitespace-nowrap"
					><span class="shrink-0">{c.label}</span><span class="text-foreground/80 min-w-0 truncate"
						>{@render value(c.field)}</span
					></span
				>
			{/each}
		</div>
	{/if}
</div>
