<script lang="ts">
	import { cn } from '../utils.js';
	import { Popover as PopoverPrimitive } from 'bits-ui';
	import type { SnakeProps } from '../bits.js';

	let {
		ref = $bindable(null),
		class: className,
		open_on_hover,
		open_delay,
		close_delay,
		...restProps
	}: SnakeProps<PopoverPrimitive.TriggerProps, {
		open_on_hover: 'openOnHover';
		open_delay: 'openDelay';
		close_delay: 'closeDelay';
	}> = $props();
</script>

<PopoverPrimitive.Trigger
	bind:ref
	data-slot="popover-trigger"
	class={cn('', className)}
	{...restProps}
	openOnHover={open_on_hover}
	openDelay={open_delay}
	closeDelay={close_delay}
/>
