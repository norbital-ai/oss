<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Shimmer } from '../shimmer';
	import { CollapsibleTrigger } from '#lib/collapsible';
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
		<div
			class="flex w-full cursor-pointer items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
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
		</div>
	</CollapsibleTrigger>
{/if}
