<script lang="ts">
	import { Pagination as PaginationPrimitive } from 'bits-ui';

	import { cn } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		count = 0,
		perPage = 10,
		page = $bindable(1),
		siblingCount = 1,
		...restProps
	}: PaginationPrimitive.RootProps = $props();
</script>

<PaginationPrimitive.Root
	bind:ref
	class={cn(
		// repository-health:allow UI6 -- bits-ui owns the pagination root and hands its page model to the children snippet; the element and its column stay the library's
		// repository-health:allow UI27 -- the column/centring of the same bits-ui root (see UI6 above)
		'mx-auto flex w-full flex-col items-center',
		className
	)}
	{count}
	{perPage}
	{siblingCount}
	bind:page
	{...restProps}
/>
