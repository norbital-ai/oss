<!--
@component
A row's actions: one shows as its button; two or more fold into one menu, so a row's actions cell stays narrow.
@example
<RowMenu {ctx} actions={[{ label: 'Archive', run: () => archive(row) }]} />
-->
<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import { words_of } from '../client/context.js';
	import { Button } from '../primitives/button/index.js';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { msg } from '../text/messages.js';

	let {
		ctx,
		actions
	}: {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** Each action's label and handler; a press never also opens the row. */
		actions: readonly { readonly label: string; readonly run: () => void }[];
	} = $props();
	const text = $derived(words_of(ctx));
</script>

{#snippet buttons()}
	{#each actions as a, i (i)}
		<Button
			variant="ghost"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				a.run();
			}}>{a.label}</Button
		>
	{/each}
{/snippet}

{#if actions.length > 1}
	<Popover.Root>
		<Popover.Trigger
			class="text-muted-foreground hover:bg-accent hover:text-foreground grid size-8 [--hit-target:2rem] place-items-center rounded-sm"
			aria-label={msg(text, 'table.rowActions')}
			data-row-menu><Glyph name="more" class="size-4" /></Popover.Trigger
		>
		<Popover.Content
			align="end"
			class="flex w-auto min-w-40 flex-col gap-0.5 p-1.5 [&>button]:justify-start"
			>{@render buttons()}</Popover.Content
		>
	</Popover.Root>
{:else}{@render buttons()}{/if}
