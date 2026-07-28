<script lang="ts">
	import Root from './carousel.svelte';
	import Content from './carousel-content.svelte';
	import Item from './carousel-item.svelte';
	import CarouselButton from './carousel-button.svelte';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';

	type Props = {
		slides: readonly unknown[];
		slideSnippet: Snippet<[{ slide: unknown; index: number }]>;
		opts?: Record<string, unknown>;
		class?: string;
	};

	let { slides, slideSnippet, opts = {}, class: className }: Props = $props();
</script>

<Root {opts} class={cn('w-full max-w-[90dvw]', className)}>
	<Content>
		{#each slides as slide, index}
			<Item>
				{@render slideSnippet({ slide, index })}
			</Item>
		{/each}
	</Content>
	<CarouselButton direction="previous" />
	<CarouselButton direction="next" />
</Root>
