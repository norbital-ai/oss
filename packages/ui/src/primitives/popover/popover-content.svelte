<script lang="ts">
	import type { SnakeProps } from '../bits.js';
	import { Stack } from '../../layout/index.js';
	import { reset_inset } from '../../layout/inset.svelte.js';
	import { cn } from '../utils.js';
	import { Popover as PopoverPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';
	let {
		ref = $bindable(null),
		class: className,
		side_offset = 4,
		align = 'center',
		portal_props,
		same_width = false,
		min_width,
		max_width,
		style = '',
		on_close_auto_focus = (e) => e.preventDefault(),
		children,
		align_offset,
		arrow_padding,
		avoid_collisions,
		collision_boundary,
		collision_padding,
		hide_when_detached,
		update_position_strategy,
		custom_anchor,
		on_open_auto_focus,
		trap_focus,
		on_interact_outside,
		interact_outside_behavior,
		on_focus_outside,
		on_escape_keydown,
		escape_keydown_behavior,
		force_mount,
		prevent_overflow_text_selection,
		prevent_scroll,
		...restProps
	}: SnakeProps<PopoverPrimitive.ContentProps, {
		side_offset: 'sideOffset';
		align_offset: 'alignOffset';
		arrow_padding: 'arrowPadding';
		avoid_collisions: 'avoidCollisions';
		collision_boundary: 'collisionBoundary';
		collision_padding: 'collisionPadding';
		hide_when_detached: 'hideWhenDetached';
		update_position_strategy: 'updatePositionStrategy';
		custom_anchor: 'customAnchor';
		on_open_auto_focus: 'onOpenAutoFocus';
		on_close_auto_focus: 'onCloseAutoFocus';
		trap_focus: 'trapFocus';
		on_interact_outside: 'onInteractOutside';
		interact_outside_behavior: 'interactOutsideBehavior';
		on_focus_outside: 'onFocusOutside';
		on_escape_keydown: 'onEscapeKeydown';
		escape_keydown_behavior: 'escapeKeydownBehavior';
		force_mount: 'forceMount';
		prevent_overflow_text_selection: 'preventOverflowTextSelection';
		prevent_scroll: 'preventScroll';
	}> & {
		portal_props?: PopoverPrimitive.PortalProps;
		same_width?: boolean;
		min_width?: number; // Minimum width in pixels
		max_width?: number; // Maximum width in pixels
		style?: string;
		children: Snippet;
	} = $props();
	// An overlay is a new page edge: it does not inherit the page's inset owner.
	reset_inset(true);

	// `start`/`end` is a preference: content that does not fit on that side of its trigger takes the other edge when
	// that side has more room, so it stays attached to the trigger instead of being shifted loose across the screen
	let flipped = $state(false);
	const placed = $derived(
		align === 'center' || !flipped ? align : align === 'start' ? 'end' : 'start'
	);
	$effect(() => {
		const content = ref,
			preferred = align;
		flipped = false;
		if (content === null || preferred === 'center') return;
		// measured once laid out (before it paints), and again as its content resizes
		const observer = new ResizeObserver(() => {
			const trigger = document.querySelector(`[aria-controls="${CSS.escape(content.id)}"]`);
			if (trigger === null) return;
			const { left, right } = trigger.getBoundingClientRect();
			const width = content.offsetWidth;
			const room = { start: window.innerWidth - left, end: right };
			const other = preferred === 'start' ? 'end' : 'start';
			flipped = room[preferred] < width && room[other] > room[preferred];
		});
		observer.observe(content);
		return () => observer.disconnect();
	});

	/* ═══════════════════════════════════════════════════════════════════ */
	/* WIDTH CONSTRAINT LOGIC                                               */
	/* ═══════════════════════════════════════════════════════════════════ */

	/**
	 * Width lives on the floating content element itself — the box that draws the border — never on
	 * an inner wrapper. A wrapper sized by `min_width` inside a shrink-to-fit outer box grows wider
	 * than the border around it, so the rows visibly spill past the popover's rounded boundary.
	 */
	const constrainedWidthStyle = $derived.by(() => {
		if (!min_width && !max_width && !same_width) return '';
		const availableWidth = 'calc(100vw - 1rem)';
		const parts = [same_width ? 'width: var(--bits-popover-anchor-width);' : 'width: max-content;'];
		if (min_width) parts.push(`min-width: ${min_width}px;`);
		parts.push(
			`max-width: ${max_width ? `min(${max_width}px, ${availableWidth})` : availableWidth};`
		);
		return parts.join(' ');
	});

	// Determine if we need width constraints
	const needsWidthConstraints = $derived.by(() => {
		return min_width || max_width || same_width;
	});

	// Combined style for the wrapper
	const combinedStyle = $derived.by(() => {
		return [constrainedWidthStyle, style].filter(Boolean).join(' ');
	});
</script>

<PopoverPrimitive.Portal {...portal_props}>
	<PopoverPrimitive.Content
		bind:ref
		data-slot="popover-content"
		align={placed}
		style={combinedStyle}
		class={cn(
			// never taller than the room on its side: a long popover scrolls rather than covering its own trigger
			'z-50 max-h-(--bits-popover-content-available-height) overflow-y-auto overscroll-contain origin-(--bits-popover-content-transform-origin) rounded-md border bg-popover text-popover-foreground shadow-deep outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
			// Apply padding and className based on whether we have constraints
			needsWidthConstraints ? '' : 'p-4',
			needsWidthConstraints ? '' : className
		)}
		{...restProps}
		sideOffset={side_offset}
		alignOffset={align_offset}
		arrowPadding={arrow_padding}
		avoidCollisions={avoid_collisions}
		collisionBoundary={collision_boundary}
		collisionPadding={collision_padding}
		hideWhenDetached={hide_when_detached}
		updatePositionStrategy={update_position_strategy}
		customAnchor={custom_anchor}
		onOpenAutoFocus={on_open_auto_focus}
		onCloseAutoFocus={on_close_auto_focus}
		trapFocus={trap_focus}
		onInteractOutside={on_interact_outside}
		interactOutsideBehavior={interact_outside_behavior}
		onFocusOutside={on_focus_outside}
		onEscapeKeydown={on_escape_keydown}
		escapeKeydownBehavior={escape_keydown_behavior}
		forceMount={force_mount}
		preventOverflowTextSelection={prevent_overflow_text_selection}
		preventScroll={prevent_scroll}
	>
		{#if needsWidthConstraints}
			<!-- The width constraint sits on the bordered content element above; this wrapper only
			     supplies the column and padding the unconstrained branch gets from `p-4`. -->
			<Stack gap="none" class={cn('p-4', className)}>
				{@render children()}
			</Stack>
		{:else}
			{@render children()}
		{/if}
	</PopoverPrimitive.Content>
</PopoverPrimitive.Portal>
