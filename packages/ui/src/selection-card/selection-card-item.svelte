<script lang="ts">
	import { Checkbox } from '#lib/checkbox';
	import { Inline } from '#lib/layout';
	import type { Snippet } from 'svelte';
	import { getSelectionCardContext } from './selection-card-root.svelte';

	// Define props for the Item component
	let {
		value,
		header,
		body,
		disabled = false
	}: {
		value: string;
		header: Snippet;
		body: Snippet;
		disabled?: boolean;
	} = $props();

	// Get the selection context from the parent (getter pattern)
	const contextGetter = getSelectionCardContext()();

	const { toggleSelection, isSelected, multiple } = contextGetter;

	// Handle toggle function
	function toggle() {
		if (!disabled) {
			toggleSelection(value);
		}
	}

	// Handle keyboard events for accessibility
	function handleKeydown(e: KeyboardEvent) {
		if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
			e.preventDefault();
			toggle();
		}
	}
</script>

<div
	role="button"
	tabindex={disabled ? -1 : 0}
	class={{
		'group flex items-start rounded-lg border p-3 shadow-sm transition-all duration-200 hover:bg-muted': true,
		'bg-muted': isSelected(value),
		'border-brand': isSelected(value),
		'cursor-pointer': !disabled,
		'cursor-not-allowed': disabled,
		'opacity-50': disabled
	}}
	onclick={toggle}
	onkeydown={handleKeydown}
	aria-pressed={isSelected(value)}
	aria-disabled={disabled}
>
	<Inline gap="md" class="grow">
		<div class="flex flex-col">
			<span class="text-sm font-medium">
				{@render header()}
			</span>
			<span class="mt-1 text-xs text-muted-foreground">
				{@render body()}
			</span>
		</div>
	</Inline>
	<Checkbox
		checked={isSelected(value)}
		class="pointer-events-none mt-1"
		aria-hidden="true"
		{disabled}
	/>
</div>
