<script lang="ts">
	import { cn } from '#lib/utils';
	import { Avatar as AvatarPrimitive } from 'bits-ui';
	import AvatarRoot from '../avatar/avatar.svelte';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: AvatarPrimitive.RootProps = $props();
</script>

<AvatarRoot bind:ref class={cn('bg-accent ring-2 ring-background', className)} {...restProps} />
