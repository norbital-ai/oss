<!-- star-rating-star.svelte -->
<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { RatingGroup } from 'bits-ui';
	import type { StarRatingStarProps } from './types.js';

	let { index, state, class: className, disabled = false, ...rest }: StarRatingStarProps = $props();

	// Use manual state if bits-ui state seems wrong
</script>

<RatingGroup.Item
	{index}
	{disabled}
	class={cn(
		'group/item size-5 cursor-pointer rounded-md ring-ring ring-offset-2 ring-offset-background outline-hidden transition-all group-aria-disabled:opacity-50 hover:scale-105 focus-visible:ring-2',
		disabled && 'cursor-not-allowed opacity-50',
		className
	)}
	{...rest}
>
	<div class="relative size-full">
		{#if state === 'active'}
			<!-- Filled star for active state -->
			<Icon
				icon="lucide:star"
				fill="currentColor"
				class="size-full text-yellow-400 transition-all"
			/>
		{:else if state === 'partial'}
			<!-- Half star using CSS masking approach -->
			<div class="relative size-full">
				<!-- Background empty star -->
				<Icon icon="lucide:star" class="size-full text-muted-foreground transition-all" />
				<!-- Half-filled overlay using CSS -->
				<div
					class="absolute inset-0 overflow-hidden [clip-path:polygon(0_0,50%_0,50%_100%,0%_100%)]"
				>
					<Icon
						icon="lucide:star"
						fill="currentColor"
						class="size-full text-yellow-400 transition-all"
					/>
				</div>
			</div>
		{:else}
			<!-- Outlined star for inactive state -->
			<Icon
				icon="lucide:star"
				class={cn('size-full transition-all', {
					'text-muted-foreground group-hover:text-yellow-300 group-data-[highlighted]:text-yellow-300':
						!disabled,
					'text-muted': disabled
				})}
			/>

			<!-- Hover preview -->
			{#if !disabled}
				<Icon
					icon="lucide:star"
					fill="currentColor"
					class="absolute top-0 left-0 size-full text-yellow-300 opacity-0 transition-all group-hover:opacity-40 group-data-[highlighted]:opacity-40"
				/>
			{/if}
		{/if}
	</div>
</RatingGroup.Item>
