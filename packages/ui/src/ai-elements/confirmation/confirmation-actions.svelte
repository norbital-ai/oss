<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import { Inline } from '#lib/layout';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	export interface ConfirmationActionsProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { getConfirmationContext } from './confirmation-context.svelte.js';

	let {
		class: className,
		children,
		ref = $bindable(null),
		...restProps
	}: ConfirmationActionsProps = $props();

	const context = getConfirmationContext();

	// Only show when approval is requested
	let shouldShow = $derived(context.state === 'approval-requested');
</script>

{#if shouldShow}
	<Inline
		gap="sm"
		justify="end"
		class={cn('self-end', className)}
		{...restProps}
		{@attach (node: HTMLDivElement) => {
			ref = node;
			return () => (ref = null);
		}}
	>
		{@render children?.()}
	</Inline>
{/if}
