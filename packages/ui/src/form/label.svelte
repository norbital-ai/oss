<script lang="ts">
	import * as FieldPrimitive from '#lib/field';
	import { Indicator } from '#lib/indicator';
	import { Inline } from '#lib/layout';
	import type { Snippet } from 'svelte';
	import { getField } from '#lib/form/context';

	let {
		children,
		after,
		hint,
		enableIndicator = true,
		before,
		...restProps
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
	<FieldPrimitive.Label for={field?.name} {...restProps}>
		<Inline as="span" gap="sm">
			{@render before?.()}
			{@render children?.()}
			{@render after?.()}
			{@render hint?.()}
		</Inline>
	</FieldPrimitive.Label>
</Indicator>
