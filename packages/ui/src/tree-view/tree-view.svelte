<script lang="ts">
	/**
	 * This is the root component for the tree view.
	 * It provides global styling and handles indentation settings.
	 */
	import { Stack } from '#lib/layout';
	import type { Snippet } from 'svelte';

	type Props = {
		class?: string;
		children?: Snippet<[]>;
		/** Control the indentation size in rem units, defaults to 1.5rem */
		indentation?: number;
		/** Control the color of the connecting lines */
		lineColor?: string;
	};

	let {
		children,
		class: className,
		indentation = 1.5, // Default indentation size in rem
		lineColor = 'hsl(var(--border))'
	}: Props = $props();
</script>

<Stack gap="none" class={className}>
	{@render children?.()}
</Stack>
