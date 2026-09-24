<script lang="ts">
	import { Cluster } from '#lib/layout';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<!-- Actions trail the footer and wrap when the dialog is too narrow for one row. -->
<Cluster
	justify="end"
	gap="sm"
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Cluster>
