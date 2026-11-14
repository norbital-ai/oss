<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import * as Popover from '../primitives/popover/index.js';
	import { words_of } from '../client/context.js';
	import { msg } from '../text/messages.js';
	let {
		ctx,
		nested = false,
		icon_only = false,
		on_condition,
		on_group
	}: { ctx: UiContext; nested?: boolean; icon_only?: boolean; on_condition(): void; on_group(): void } = $props();
	const bolt = $derived(words_of(ctx));
	let open = $state(false);
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="text-muted-foreground hover:text-foreground inline-flex self-start items-center rounded-sm px-1 py-1 text-left text-xs focus-visible:outline focus-visible:outline-2"
				aria-label={msg(bolt, 'view.addCondition')}
				data-add-filter
			>
				+ <span class={icon_only ? 'sr-only' : undefined}>{msg(bolt, 'view.add')}</span>
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		align="start"
		class="flex w-52 flex-col gap-1 p-1"
		aria-label={msg(bolt, 'view.addCondition')}
	>
		<button
			type="button"
			class="hover:bg-muted rounded-sm px-2 py-1.5 text-left text-xs"
			data-add-condition={!nested ? '' : undefined}
			data-add-nested={nested ? '' : undefined}
			onclick={() => {
				open = false;
				on_condition();
			}}>{msg(bolt, 'view.addCondition')}</button
		>
		<button
			type="button"
			class="hover:bg-muted rounded-sm px-2 py-1.5 text-left text-xs"
			data-add-group={!nested ? '' : undefined}
			data-add-nested-group={nested ? '' : undefined}
			onclick={() => {
				open = false;
				on_group();
			}}
			>{msg(bolt, 'view.addSet')}<span
				class="text-muted-foreground mt-0.5 block text-xs"
				>{msg(bolt, 'view.addSetHelp')}</span
			></button
		>
	</Popover.Content>
</Popover.Root>
