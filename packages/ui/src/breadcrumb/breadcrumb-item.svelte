<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { Inline } from '#lib/layout';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLLiAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: WithElementRef<HTMLLiAttributes> = $props();
</script>

<Inline
	as="li"
	gap="xs"
	{...restProps as HTMLAttributes<HTMLElement>}
	{@attach (node: HTMLLIElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Inline>
