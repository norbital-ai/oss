<script lang="ts">
	// An internal primitive (final-ui §7.4, id 713): where a page sits, as links; the last item is the current page.
	import Icon from '@iconify/svelte';
	import { cn } from '../utils.js';

	let { items, class: className, 'aria-label': label = 'Breadcrumb' }: {
		items: readonly { label: string; href?: string }[]; class?: string; 'aria-label'?: string;
	} = $props();
</script>

<nav aria-label={label} class={className}>
	<ol class={cn('flex flex-wrap items-center gap-1.5 text-sm break-words text-muted-foreground')}>
		{#each items as item, i (i)}
			{#if i > 0}<li role="presentation" aria-hidden="true"><Icon icon="lucide:chevron-right" class="size-3.5" /></li>{/if}
			<li class="inline-flex items-center">
				{#if i === items.length - 1}<span aria-current="page" class="font-normal text-foreground">{item.label}</span>
				{:else if item.href !== undefined}<a href={item.href} class="transition-colors hover:text-foreground">{item.label}</a>
				{:else}{item.label}{/if}
			</li>
		{/each}
	</ol>
</nav>
