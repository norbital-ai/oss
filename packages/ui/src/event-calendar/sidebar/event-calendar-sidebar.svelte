<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';

	const { t } = useI18n<UiKeys>();
	import { Scroll } from '#lib/layout';
	import type { Snippet } from 'svelte';

	let {
		children,
		class: className
	}: {
		children: Snippet;
		class?: string;
	} = $props();
</script>

<!-- stupidity:allow UI15 -- the calendar sidebar is a deliberately fixed navigation rail -->
<Scroll
	axis="y"
	name={t('misc.calendarSidebar')}
	shrink={false}
	class={cn('w-[240px] border-r border-border bg-card/50', className)}
>
	{@render children()}
</Scroll>
