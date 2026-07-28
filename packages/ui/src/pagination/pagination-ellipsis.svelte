<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import type { WithElementRef, WithoutChildren } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLSpanElement>>> = $props();
</script>

<span
	bind:this={ref}
	aria-hidden="true"
	class={cn('flex size-9 items-center justify-center', className)}
	{...restProps}
>
	<Icon icon="lucide:ellipsis" class="size-4" />
	<span class="sr-only">More pages</span>
</span>
