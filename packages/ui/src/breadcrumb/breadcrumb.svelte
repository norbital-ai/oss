<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();

	const { t } = useI18n<UiKeys>();
</script>

<nav bind:this={ref} class={className} aria-label={t('misc.breadcrumb')} {...restProps}>
	{@render children?.()}
</nav>
