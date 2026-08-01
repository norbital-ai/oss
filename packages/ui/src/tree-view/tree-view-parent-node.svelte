<script lang="ts">
	/**
	 * This component handles collapsible parent nodes with children.
	 * It renders a collapsible section with a toggle button and indented children.
	 */
	import * as Collapsible from '#lib/collapsible';
	import { Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';

	type Props = {
		/** Bindable open state */
		open?: boolean;
		/** Initial open state, will override open */
		defaultOpen?: boolean;
		/** Additional CSS classes */
		class?: string;
		/** Content snippet for the node header */
		content?: Snippet<[{ open: boolean }]>;
		/** Children snippet for nested nodes */
		children?: Snippet<[]>;
	};

	let { open = $bindable(true), class: className, content, children }: Props = $props();
</script>

<Collapsible.Root bind:open>
	<Collapsible.Trigger class={cn('flex w-full place-items-center items-center gap-1', className)}>
		{@render content?.({ open: open ?? false })}
	</Collapsible.Trigger>
	<Collapsible.Content class="ml-3.75 border-l">
		<Inline align="start" gap="none" class="relative">
			<!-- stupidity:allow UI13 -- the connector line needs symmetric inline clearance from both tree branches -->
			<div class="mx-2 h-full w-[1px] shrink-0 bg-border"></div>
			<Stack gap="none" grow>
				{@render children?.()}
			</Stack>
		</Inline>
	</Collapsible.Content>
</Collapsible.Root>

<style>
	@keyframes slideDown {
		from {
			height: 0;
			opacity: 0;
		}
		to {
			height: var(--radix-collapsible-content-height);
			opacity: 1;
		}
	}
	@keyframes slideUp {
		from {
			height: var(--radix-collapsible-content-height);
			opacity: 1;
		}
		to {
			height: 0;
			opacity: 0;
		}
	}
</style>
