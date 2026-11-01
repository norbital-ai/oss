<script lang="ts">
	import * as Popover from '../primitives/popover/index.js';
	import { useBolt } from '../client/context.js';
	import { msg } from '../text/messages.js';
	let {
		nested = false,
		iconOnly = false,
		onCondition,
		onGroup
	}: { nested?: boolean; iconOnly?: boolean; onCondition(): void; onGroup(): void } = $props();
	const bolt = useBolt();
	let open = $state(false);
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="text-muted-foreground hover:text-foreground inline-flex self-start items-center rounded-sm px-1 py-1 text-left text-xs focus-visible:outline focus-visible:outline-2"
				aria-label={msg(bolt, 'view.addCondition', 'Add condition')}
				data-add-filter
			>
				+ <span class={iconOnly ? 'sr-only' : undefined}>{msg(bolt, 'view.add', 'Add')}</span>
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		align="start"
		class="flex w-52 flex-col gap-1 p-1"
		aria-label={msg(bolt, 'view.addCondition', 'Add condition')}
	>
		<button
			type="button"
			class="hover:bg-muted rounded-sm px-2 py-1.5 text-left text-xs"
			data-add-condition={!nested ? '' : undefined}
			data-add-nested={nested ? '' : undefined}
			onclick={() => {
				open = false;
				onCondition();
			}}>{msg(bolt, 'view.addCondition', 'Add condition')}</button
		>
		<button
			type="button"
			class="hover:bg-muted rounded-sm px-2 py-1.5 text-left text-xs"
			data-add-group={!nested ? '' : undefined}
			data-add-nested-group={nested ? '' : undefined}
			onclick={() => {
				open = false;
				onGroup();
			}}
			>{msg(bolt, 'view.addSet', 'Add a set of conditions')}<span
				class="text-muted-foreground mt-0.5 block text-xs"
				>{msg(bolt, 'view.addSetHelp', 'Match any or all of several conditions')}</span
			></button
		>
	</Popover.Content>
</Popover.Root>
