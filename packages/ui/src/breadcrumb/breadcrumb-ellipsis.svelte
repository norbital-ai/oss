<script lang="ts">
	import { Frame } from '#lib/layout';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { WithElementRef, WithoutChildren } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLSpanElement>>> = $props();

	const { t } = useI18n<UiKeys>();
</script>

<Frame
	as="span"
	ratio="square"
	role="presentation"
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
