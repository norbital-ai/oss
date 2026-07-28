<script lang="ts">
	import * as FieldPrimitive from '#lib/field';
	import { Indicator } from '#lib/indicator';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import { getField } from './context';

	let {
		class: className,
		children,
		after,
		hint,
		enableIndicator = true,
		before
	}: {
		class?: string;
		children?: Snippet<[]>;
		after?: Snippet<[]>;
		before?: Snippet<[]>;
		hint?: Snippet<[]>;
		enableIndicator?: boolean;
	} = $props();

	const field = getField()();
	const hasChanges = $derived(enableIndicator && (field?.delta?.length ?? 0) > 0);
</script>

<Indicator size="sm" variant="info" visible={hasChanges}>
	<FieldPrimitive.Label for={field?.name} class={cn('flex flex-row items-center gap-2', className)}>
		{@render before?.()}
		{@render children?.()}
		{@render after?.()}
		{@render hint?.()}
	</FieldPrimitive.Label>
</Indicator>
