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

<Stack
	gap="sm"
	align="center"
	justify="center"
	class={cn('size-full p-8 text-center', className)}
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
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
</Stack>
