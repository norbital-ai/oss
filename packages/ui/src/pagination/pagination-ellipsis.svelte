<script lang="ts">
	import { Frame } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import Icon from '@iconify/svelte';
	import type { WithElementRef, WithoutChildren } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	const { t } = useI18n<UiKeys>();

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLSpanElement>>> = $props();
</script>

<Frame
	as="span"
	ratio="square"
	aria-hidden="true"
	class={cn('size-9', className)}
	{...restProps as HTMLAttributes<HTMLElement>}
	{@attach (node: HTMLSpanElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	<Icon icon="lucide:ellipsis" class="size-4" />
	<span class="sr-only">{t('common.more')}</span>
</Frame>
