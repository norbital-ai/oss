<script lang="ts">
	import { cn } from '#lib/utils';
	import { getContext } from 'svelte';
	import type { Snippet } from 'svelte';
	import { type AvatarLoadingState, AVATAR_KEY } from './avatar.svelte';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: {
		ref?: HTMLElement | null;
		class?: string;
		children?: Snippet;
		[key: string]: unknown;
	} = $props();

	const ctx = getContext<AvatarLoadingState>(AVATAR_KEY);
</script>

<img
	bind:this={ref}
	class={cn('aspect-square h-full w-full', className)}
	onload={() => {
		if (ctx) ctx.loaded = true;
	}}
	onerror={() => {
		if (ctx) ctx.error = true;
	}}
	{...restProps}
/>
