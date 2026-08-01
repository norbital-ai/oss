<script lang="ts">
	import { cn } from '#lib/utils';
	import { CommandState, setCommandState } from './command-state.svelte.js';
	import type { CommandRootProps } from './types.js';

	let {
		ref = $bindable(null),
		items = undefined,
		value = undefined,
		activeValue = undefined,
		searchValue = $bindable(''),
		shouldFilter = true,
		filter,
		columns,
		class: className,
		children,
		onValueChange,
		onIndicatorKeydown,
		disableNavigation = false,
		...restProps
	}: CommandRootProps = $props();

	// Create state with getters for reactive prop access
	// svelte-ignore state_referenced_locally
	const commandState = new CommandState({
		get items() {
			return items;
		},
		get searchValue() {
			return searchValue;
		},
		get value() {
			return value;
		},
		get activeValue() {
			return activeValue;
		},
		shouldFilter,
		filterFn: filter,
		columns,
		onChange: onValueChange
	});

	// Provide state via context
	setCommandState(() => commandState);

	// Event handlers
	function handleMouseMove() {
		commandState.inputMode = 'mouse';
	}

	function handleKeydown(e: KeyboardEvent) {
		if (disableNavigation) return;
		if (!commandState.isInputFocused) return;

		const isWithinCommand = ref?.contains(e.target as Node);
		if (!isWithinCommand) return;

		const navigationKeys = [
			'ArrowDown',
			'ArrowUp',
			'ArrowLeft',
			'ArrowRight',
			'Home',
			'End',
			'Enter',
			'Escape'
		];
		if (!navigationKeys.includes(e.key)) return;

		commandState.inputMode = 'keyboard';

		// Check if there are visible items to navigate after restoring keyboard mode.
		if (commandState.visibleItems.length === 0) return;

		if (
			onIndicatorKeydown?.(e, {
				indicatorValue: commandState.resolvedIndicatorValue,
				items: commandState.visibleItems
			})
		) {
			return;
		}

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				commandState.navigateDown();
				break;
			case 'ArrowUp':
				e.preventDefault();
				commandState.navigateUp();
				break;
			case 'ArrowLeft':
				e.preventDefault();
				commandState.navigateLeft();
				break;
			case 'ArrowRight':
				e.preventDefault();
				commandState.navigateRight();
				break;
			case 'Home':
				e.preventDefault();
				commandState.navigateFirst();
				break;
			case 'End':
				e.preventDefault();
				commandState.navigateLast();
				break;
			case 'Enter':
				e.preventDefault();
				const indicatorElement = ref?.querySelector<HTMLElement>('[data-indicator="true"]');
				indicatorElement?.click();
				commandState.selectCurrent();
				break;
			case 'Escape':
				const input = ref?.querySelector<HTMLElement>('[data-command-input]');
				input?.blur();
				break;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- stupidity:allow UI5; stupidity:allow UI9 -- this leaf component owns a local clip or scroll boundary required by its interaction contract; this local clip boundary contains, rather than duplicates, the descendant scroll owner -->
<div
	bind:this={ref}
	class={cn(
		'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
		className
	)}
	data-command-root="true"
	data-input-focused={commandState.isInputFocused ? 'true' : undefined}
	data-shows-indicator={commandState.shouldShowIndicator ? 'true' : undefined}
	data-resolved-indicator={commandState.resolvedIndicatorValue || undefined}
	onmousemove={handleMouseMove}
	{...restProps}
>
	{#if children}
		{@render children()}
	{/if}
</div>
