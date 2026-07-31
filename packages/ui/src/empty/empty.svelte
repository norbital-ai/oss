<!-- Empty.svelte -->
<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { Stack } from '#lib/layout';

	let {
		title = 'No items found',
		description = 'Get started by creating your first item.',
		icon = 'lucide:inbox',
		iconClass = 'w-12 h-12',
		iconWellClass = '',
		containerClass = '',
		titleClass = '',
		descriptionClass = '',
		children = undefined,
		align = 'center' as 'center' | 'left',
		hideIcon = false
	} = $props();
</script>

<Stack
	gap="md"
	class={cn(
		'min-h-[400px] justify-center p-8',
		align === 'left' ? 'items-start text-left' : 'items-center text-center',
		containerClass
	)}
>
	{#if !hideIcon}
		<div
			class={cn('flex h-20 w-20 items-center justify-center rounded-full bg-muted', iconWellClass)}
		>
			<Icon {icon} class={cn('text-muted-foreground', iconClass)} />
		</div>
	{/if}

	<Stack gap="sm">
		<h3 class={cn('text-section', titleClass)}>{title}</h3>
		<p class={cn('text-sm text-muted-foreground', descriptionClass)}>{description}</p>
	</Stack>

	{#if children}
		<div class="w-full">
			{@render children()}
		</div>
	{/if}
</Stack>
