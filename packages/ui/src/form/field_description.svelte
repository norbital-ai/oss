<script lang="ts">
	import * as FieldPrimitive from '#lib/field';

	let {
		children,
		...restProps
	}: {
		class?: string;
		children?: import('svelte').Snippet;
	} = $props();
</script>

<FieldPrimitive.Description {...restProps}>
	{@render children?.()}
</FieldPrimitive.Description>
