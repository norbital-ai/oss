<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Shimmer } from '#lib/ai-elements/shimmer';
	import { CollapsibleTrigger } from '#lib/collapsible';
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { Collapsible as CollapsiblePrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';

	export interface EventTriggerProps extends CollapsiblePrimitive.TriggerProps {
		title: string;
		class?: string;
		children?: Snippet;
		/** Enable shimmer effect on the title text */
		shimmer?: boolean;
	}

	let {
		children,
		class: className,
		title,
		shimmer = false,
		...restProps
	}: EventTriggerProps = $props();
</script>

{#if children}
	<CollapsibleTrigger class={cn('group', className)} {...restProps}>
		{@render children?.()}
	</CollapsibleTrigger>
{:else}
	<CollapsibleTrigger class={cn('group', className)} {...restProps}>
		<Inline
			gap="sm"
			class="cursor-pointer text-sm text-muted-foreground transition-colors hover:text-foreground"
		>
			<Icon icon="lucide:search" class="size-4" />
			{#if shimmer}
				<Shimmer class="text-sm" content_length={title.length}>
					{title}
				</Shimmer>
			{:else}
				<p class="text-sm">{title}</p>
			{/if}
			<Icon
				icon="lucide:chevron-down"
				class="size-4 transition-transform group-data-[state=open]:rotate-180"
			/>
		</Inline>
	</CollapsibleTrigger>
{/if}
