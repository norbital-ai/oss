<script lang="ts">
	import * as Dialog from '#lib/dialog';
	import Root from './command.svelte';
	import type { CommandDialogProps } from '#lib/command/types';

	let {
		open = $bindable(false),
		value = $bindable(''),
		onOpenChange,
		children,
		...restProps
	}: CommandDialogProps = $props();
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="overflow-hidden p-0 shadow-lg">
		<Root
			{value}
			class="[&_[data-command-group]]:px-2 [&_[data-command-group]:not([hidden])_~[data-command-group]]:pt-0 [&_[data-command-input-wrapper]_svg]:h-5 [&_[data-command-input-wrapper]_svg]:w-5 [&_[data-command-input]]:h-12 [&_[data-command-item]]:px-2 [&_[data-command-item]]:py-3 [&_[data-command-item]_svg]:h-5 [&_[data-command-item]_svg]:w-5"
			{...restProps}
		>
			{#if children}
				{@render children()}
			{/if}
		</Root>
	</Dialog.Content>
</Dialog.Root>
