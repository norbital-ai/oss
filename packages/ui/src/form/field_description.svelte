<script lang="ts">
	import * as FieldPrimitive from '#lib/field';

	let {
		class: className,
		children
	}: {
		class?: string;
		children?: import('svelte').Snippet;
	} = $props();
</script>

<FieldPrimitive.Description class={className}>
	{@render children?.()}
</FieldPrimitive.Description>
