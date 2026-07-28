<script lang="ts">
	import { cn } from '#lib/utils';
	import { getContext } from 'svelte';
	import type { Snippet } from 'svelte';
	import { type AvatarLoadingState, AVATAR_KEY } from './avatar.svelte';

	let {
		ref = $bindable(null),
		class: className,
		identifier = '',
		children,
		...restProps
	}: {
		ref?: HTMLElement | null;
		class?: string;
		identifier?: string;
		children?: Snippet;
	} = $props();

	const ctx = getContext<AvatarLoadingState>(AVATAR_KEY);

	function stringToColor(str: string): string {
		if (!str) return 'hsl(215, 20%, 65%)';
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = str.charCodeAt(i) + ((hash << 5) - hash);
		}
		const h = Math.abs(hash) % 360;
		const s = 65;
		const l = 55;
		return `hsl(${h}, ${s}%, ${l}%)`;
	}

	let backgroundColor = $derived(stringToColor(identifier));
</script>

<span
	bind:this={ref}
	class={cn('flex h-full w-full items-center justify-center rounded-full', className)}
	style={ctx?.loaded ? 'display: none' : `background-color: ${backgroundColor};`}
	{...restProps}
>
	{@render children?.()}
</span>
