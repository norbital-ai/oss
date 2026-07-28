<script module lang="ts">
	export const AVATAR_KEY = Symbol('avatar-root');
</script>

<script lang="ts">
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

<div
	bind:this={ref}
	class={cn('relative flex size-10 shrink-0 overflow-hidden rounded-full', className)}
	{...restProps}
>
	{@render children?.()}
</div>
