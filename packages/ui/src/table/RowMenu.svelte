<!--
@component
A row's actions: one shows as its button; two or more fold into one menu, so a row's actions cell stays narrow.
@example
<RowMenu {ctx} actions={[{ label: 'Archive', run: () => archive(row) }]} />
-->
<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import { words_of } from '../client/context.js';
	import { create_roving_focus, create_typeahead } from '../behaviors/index.js';
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
	let open = $state(false);
	const keys = $derived(actions.map((_, i) => String(i)));
	const roving = create_roving_focus({
		items: () => keys,
		orientation: 'vertical',
		on_activate: (key) => {
			const action = actions[Number(key)];
			if (action === undefined) return;
			open = false;
			action.run();
		}
	});
	const typeahead = create_typeahead({
		items: () => actions.map((a, i) => ({ key: String(i), text: a.label })),
		active: () => roving.active,
		on_match: (k) => roving.focus(k)
	});
	function onMenuKeydown(event: KeyboardEvent): void {
		roving.root_attrs().onkeydown(event);
		if (!event.defaultPrevented) typeahead.onkeydown(event);
	}
</script>

{#if actions.length > 1}
	<Popover.Root bind:open>
		<Popover.Trigger
			class="text-muted-foreground hover:bg-accent hover:text-foreground grid size-8 [--hit-target:2rem] place-items-center rounded-sm"
			aria-label={msg(text, 'table.rowActions')}
			aria-haspopup="menu"
			data-row-menu><Glyph name="more" class="size-4" /></Popover.Trigger
		>
		<Popover.Content
			align="end"
			role="menu"
			aria-label={msg(text, 'table.rowActions')}
			onkeydown={onMenuKeydown}
			class="flex w-auto min-w-40 flex-col gap-0.5 p-1.5 [&>button]:justify-start"
		>
			{#each actions as a, i (i)}
				{@const rov = roving.item_attrs(String(i))}
				<Button
					variant="ghost"
					role="menuitem"
					tabindex={rov.tabindex}
					onfocus={rov.onfocus}
					{@attach roving.item(String(i))}
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						open = false;
						a.run();
					}}>{a.label}</Button
				>
			{/each}
		</Popover.Content>
	</Popover.Root>
{:else}
	{#each actions as a, i (i)}
		<Button
			variant="ghost"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				a.run();
			}}>{a.label}</Button
		>
	{/each}
{/if}
