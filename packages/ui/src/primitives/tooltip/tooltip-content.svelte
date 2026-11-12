<script lang="ts">
	import type { SnakeProps } from '../bits.js';
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import { cn } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		side_offset = 0,
		side = 'top',
		children,
		arrow_classes,
		align_offset,
		arrow_padding,
		avoid_collisions,
		collision_boundary,
		collision_padding,
		hide_when_detached,
		update_position_strategy,
		custom_anchor,
		on_interact_outside,
		interact_outside_behavior,
		on_focus_outside,
		on_escape_keydown,
		escape_keydown_behavior,
		force_mount,
		...restProps
	}: SnakeProps<TooltipPrimitive.ContentProps, {
		side_offset: 'sideOffset';
		align_offset: 'alignOffset';
		arrow_padding: 'arrowPadding';
		avoid_collisions: 'avoidCollisions';
		collision_boundary: 'collisionBoundary';
		collision_padding: 'collisionPadding';
		hide_when_detached: 'hideWhenDetached';
		update_position_strategy: 'updatePositionStrategy';
		custom_anchor: 'customAnchor';
		on_interact_outside: 'onInteractOutside';
		interact_outside_behavior: 'interactOutsideBehavior';
		on_focus_outside: 'onFocusOutside';
		on_escape_keydown: 'onEscapeKeydown';
		escape_keydown_behavior: 'escapeKeydownBehavior';
		force_mount: 'forceMount';
	}> & {
		/** The Bits UI arrow uses currentColor for its fill. */
		arrow_classes?: string;
	} = $props();
</script>

<TooltipPrimitive.Portal>
	<TooltipPrimitive.Content
		bind:ref
		data-slot="tooltip-content"
		{side}
		class={cn(
			'z-50 w-fit origin-(--bits-tooltip-content-transform-origin) animate-in rounded-md bg-primary px-3 py-1.5 text-xs text-balance text-primary-foreground fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
			className
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
		onInteractOutside={on_interact_outside}
		interactOutsideBehavior={interact_outside_behavior}
		onFocusOutside={on_focus_outside}
		onEscapeKeydown={on_escape_keydown}
		escapeKeydownBehavior={escape_keydown_behavior}
		forceMount={force_mount}
	>
		{@render children?.()}
		<TooltipPrimitive.Arrow class={cn('z-50 text-primary', arrow_classes)} />
	</TooltipPrimitive.Content>
</TooltipPrimitive.Portal>
