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

	/**
	 * Width lives on the floating content element itself — the box that draws the border — never on
	 * an inner wrapper. A wrapper sized by `minWidth` inside a shrink-to-fit outer box grows wider
	 * than the border around it, so the rows visibly spill past the popover's rounded boundary.
	 */
	const constrainedWidthStyle = $derived.by(() => {
		if (!minWidth && !maxWidth && !sameWidth) return '';
		const availableWidth = 'calc(100vw - 1rem)';
		const parts = [sameWidth ? 'width: var(--bits-popover-anchor-width);' : 'width: max-content;'];
		if (minWidth) parts.push(`min-width: ${minWidth}px;`);
		parts.push(
			`max-width: ${maxWidth ? `min(${maxWidth}px, ${availableWidth})` : availableWidth};`
		);
		return parts.join(' ');
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
		style={combinedStyle}
		class={cn(
			'z-50 origin-(--bits-popover-content-transform-origin) rounded-md border bg-popover text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
			// Apply padding and className based on whether we have constraints
			needsWidthConstraints ? '' : 'p-4',
			needsWidthConstraints ? '' : className
		)}
		{...restProps}
	>
		{#if needsWidthConstraints}
			<!-- The width constraint sits on the bordered content element above; this wrapper only
			     supplies the flex column and padding the unconstrained branch gets from `p-4`. -->
			<div
				class={cn(
					'flex min-w-0 flex-col p-4', // Default to flex column to match typical popover behavior
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
