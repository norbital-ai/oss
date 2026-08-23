<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { Scroll } from '#lib/layout';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn, type WithElementRef } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();

	const { t } = useI18n<UiKeys>();
</script>

<Scroll
	axis="y"
	name={t('misc.sidebar')}
	layout="stack"
	gap="sm"
	grow
	bind:ref
	data-slot="sidebar-content"
	data-sidebar="content"
	class={cn('group-data-[collapsible=icon]:overflow-hidden', className)}
	{...restProps}
>
	{@render children?.()}
</Scroll>
