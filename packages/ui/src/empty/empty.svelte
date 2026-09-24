<!-- Empty.svelte -->
<script lang="ts">
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import Icon from '@iconify/svelte';
	import { Frame, Stack } from '#lib/layout';

	const { t } = useI18n<UiKeys>();

	let {
		title,
		description,
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

	const titleEffective = $derived(title ?? t('common.noItemsFound'));
	const descriptionEffective = $derived(description ?? t('common.emptyGetStarted'));
</script>

<Stack
	gap="md"
	justify="center"
	align={align === 'left' ? 'start' : 'center'}
	class={cn('p-8', align === 'left' ? 'text-left' : 'text-center', containerClass)}
>
	{#if !hideIcon}
		<Frame ratio="square" shrink={false} class={cn('size-20 rounded-full bg-muted', iconWellClass)}>
			<Icon {icon} class={cn('text-muted-foreground', iconClass)} />
		</Frame>
	{/if}

	<Stack gap="sm">
		<h3 class={cn('text-section', titleClass)}>{titleEffective}</h3>
		<p class={cn('text-sm text-muted-foreground', descriptionClass)}>{descriptionEffective}</p>
	</Stack>

	{#if children}
		<div class="w-full">
			{@render children()}
		</div>
	{/if}
</Stack>
