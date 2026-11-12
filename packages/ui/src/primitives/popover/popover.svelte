<script lang="ts">
	import { Popover } from 'bits-ui';

	let {
		open = $bindable(false),
		on_open_change,
		on_open_change_complete,
		children
	}: Omit<Popover.RootProps, 'onOpenChange' | 'onOpenChangeComplete'> & {
		on_open_change?: Popover.RootProps['onOpenChange'];
		on_open_change_complete?: Popover.RootProps['onOpenChangeComplete'];
	} = $props();
</script>

<Popover.Root bind:open onOpenChange={on_open_change} onOpenChangeComplete={on_open_change_complete}>
	{@render children?.()}
</Popover.Root>
