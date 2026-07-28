<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { cn } from '#lib/utils';
	import type { ComponentProps } from 'svelte';
	import { useSidebar } from './context.svelte.js';

	let {
		ref = $bindable(null),
		class: className,
		target = 'visibility',
		onclick,
		...restProps
	}: ComponentProps<typeof Button> & {
		target?: 'visibility' | 'expansion';
		onclick?: (e: MouseEvent) => void;
	} = $props();

	const sidebar = useSidebar()();
</script>

<Button
	data-sidebar="trigger"
	data-slot="sidebar-trigger"
	variant="ghost"
	size="icon"
	class={cn('size-7', className)}
	type="button"
	onclick={(e) => {
		onclick?.(e);
		if (target === 'expansion') sidebar.toggleExpansion();
		else sidebar.toggle();
	}}
	{...restProps}
>
	<Icon icon={sidebar.isMobile ? 'lucide:panel-bottom' : 'lucide:panel-left'} />
</Button>
