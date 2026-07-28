<script lang="ts">
	import { cn } from '#lib/utils';
	import { Popover as PopoverPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';
	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 4,
		align = 'center',
		portalProps,
		sameWidth = false,
		minWidth,
		maxWidth,
		style = '',
		onCloseAutoFocus = (e) => e.preventDefault(),
		children,
		...restProps
	}: PopoverPrimitive.ContentProps & {
		portalProps?: PopoverPrimitive.PortalProps;
		sameWidth?: boolean;
		minWidth?: number; // Minimum width in pixels
		maxWidth?: number; // Maximum width in pixels
		style?: string;
		children: Snippet;
	} = $props();

	/* ═══════════════════════════════════════════════════════════════════ */
	/* WIDTH CONSTRAINT LOGIC                                               */
	/* ═══════════════════════════════════════════════════════════════════ */

	/** Calculate width with proper sameWidth and boundary handling */
	const constrainedWidthStyle = $derived.by(() => {
		if (!minWidth && !maxWidth && !sameWidth) return '';

		// Determine base width behavior
		const baseWidth = sameWidth ? 'var(--bits-popover-anchor-width)' : '100%';
		const availableWidth = 'calc(100vw - 1rem)';

		// Apply boundaries if present
		if (minWidth && maxWidth) {
			// Both boundaries: use clamp to ensure width stays within bounds
			return `width: min(clamp(${minWidth}px, ${baseWidth}, ${maxWidth}px), ${availableWidth});`;
		}

		if (minWidth && !maxWidth) {
			// Only minimum: ensure width is at least minWidth
			return `width: min(max(${minWidth}px, ${baseWidth}), ${availableWidth});`;
		}

		if (!minWidth && maxWidth) {
			// Only maximum: ensure width doesn't exceed maxWidth
			return `width: min(${baseWidth}, ${maxWidth}px, ${availableWidth});`;
		}

		// Only sameWidth
		return `width: min(${baseWidth}, ${availableWidth});`;
	});

	// Determine if we need width constraints
	const needsWidthConstraints = $derived.by(() => {
		return minWidth || maxWidth || sameWidth;
	});

	// Combined style for the wrapper
	const combinedStyle = $derived.by(() => {
		return [constrainedWidthStyle, style].filter(Boolean).join(' ');
	});
</script>

<PopoverPrimitive.Portal {...portalProps}>
	<PopoverPrimitive.Content
		bind:ref
		data-slot="popover-content"
		{sideOffset}
		{align}
		{onCloseAutoFocus}
		class={cn(
			'z-50 origin-(--bits-popover-content-transform-origin) rounded-md border bg-popover text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
			// Apply padding and className based on whether we have constraints
			needsWidthConstraints ? '' : 'p-4',
			needsWidthConstraints ? '' : className
		)}
		{...restProps}
	>
		{#if needsWidthConstraints}
			<!-- Wrapper inherits flex properties and handles width constraints -->
			<div
				style={combinedStyle}
				class={cn(
					'flex flex-col p-4', // Default to flex column to match typical popover behavior
					className
				)}
			>
				{@render children()}
			</div>
		{:else}
			{@render children()}
		{/if}
	</PopoverPrimitive.Content>
</PopoverPrimitive.Portal>
