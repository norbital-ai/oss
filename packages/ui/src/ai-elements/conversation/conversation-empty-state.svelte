<script lang="ts" module>
	import { cn, type WithElementRef } from '#lib/utils';
	import { Stack } from '#lib/layout';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	interface ConversationEmptyStateProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
		title?: string;
		description?: string;
		icon?: Snippet;
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';

	const { t } = useI18n<UiKeys>();

	let {
		class: className,
		title = t('misc.noMessagesYet'),
		description = t('misc.startConversation'),
		icon,
		children,
		ref = $bindable(null),
		...restProps
	}: ConversationEmptyStateProps = $props();
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<div
	bind:this={ref}
	class={cn('flex size-full flex-col items-center justify-center gap-3 p-8 text-center', className)}
	{...restProps}
>
	{#if children}
		{@render children?.()}
	{:else}
		{#if icon}
			<div class="text-muted-foreground">
				{@render icon()}
			</div>
		{/if}
		<Stack gap="xs">
			<h3 class="text-sm font-medium">{title}</h3>
			{#if description}
				<p class="text-muted-foreground text-sm">{description}</p>
			{/if}
		</Stack>
	{/if}
</div>
