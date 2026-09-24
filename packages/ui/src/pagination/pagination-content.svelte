<script lang="ts">
	import { Inline } from '#lib/layout';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLUListElement>> = $props();
</script>

<Inline
	as="ul"
	gap="xs"
	{...restProps as HTMLAttributes<HTMLElement>}
	{@attach (node: HTMLUListElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Inline>
