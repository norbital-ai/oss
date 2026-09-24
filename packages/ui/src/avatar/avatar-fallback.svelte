<script lang="ts">
	import { Inline } from '#lib/layout';
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

<Inline
	as="span"
	justify="center"
	class={cn('h-full w-full rounded-full', className)}
	style={ctx?.loaded ? 'display: none' : `background-color: ${backgroundColor};`}
	{...restProps}
	{@attach (node: HTMLElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Inline>
