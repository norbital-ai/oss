<script lang="ts">
	import { Dialog } from 'bits-ui';

	let {
		open = $bindable(false),
		on_open_change,
		on_open_change_complete,
		children
	}: Omit<Dialog.RootProps, 'onOpenChange' | 'onOpenChangeComplete'> & {
		on_open_change?: Dialog.RootProps['onOpenChange'];
		on_open_change_complete?: Dialog.RootProps['onOpenChangeComplete'];
	} = $props();
</script>

<Dialog.Root bind:open onOpenChange={on_open_change} onOpenChangeComplete={on_open_change_complete}>
	{@render children?.()}
</Dialog.Root>
