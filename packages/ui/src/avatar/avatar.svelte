<script module lang="ts">
	export const AVATAR_KEY = Symbol('avatar-root');
</script>

<script lang="ts">
	import { Frame } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { setContext } from 'svelte';
	import type { Snippet } from 'svelte';

	export type AvatarLoadingState = { loaded: boolean; error: boolean };

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

	const state = $state<AvatarLoadingState>({ loaded: false, error: false });
	setContext(AVATAR_KEY, state);
</script>

<Frame
	ratio="square"
	shrink={false}
	class={cn('relative size-10 rounded-full', className)}
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Frame>
