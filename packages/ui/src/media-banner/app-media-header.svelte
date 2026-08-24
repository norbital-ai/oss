<!-- exported package app chrome rendered by bolt shell -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { IconWrapper } from '#lib/icon-wrapper';
	import { INSET_X_CLASS, Cluster, Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';

	let {
		src = null,
		icon = null,
		title = null,
		description = null,
		actions,
		class: className
	}: {
		/**
		 * App banner image (`bolt:banner`). Decorative only — copy sits on the dark scrim.
		 * Optional: without one the header keeps its base wash and stays legible.
		 */
		src?: string | null;
		/** App icon (`bolt:icon`). Opaque chip so it stays readable on any banner. */
		icon?: string | null;
		title?: string | null;
		description?: string | null;
		/**
		 * Trailing controls for the running app — a scope picker, an export button.
		 *
		 * This exists so an app does not have to repeat its own title in a second `PageHeader` just
		 * to hang a control off it. Identity is rendered once, here, and the app contributes only
		 * the part the shell cannot know.
		 */
		actions?: Snippet;
		class?: string;
	} = $props();

	let failedSrc = $state<string | null>(null);
	let loadedSrc = $state<string | null>(null);

	const imageFailed = $derived(src == null || src === failedSrc);
	const imageLoaded = $derived(src != null && src === loadedSrc);
</script>

<!--
	Airbnb-style photo card chrome: full-bleed media, bottom-weighted dark scrim,
	identity copy on the scrim. Banner art never owns text contrast.
-->
<div class={cn('relative h-28 shrink-0 overflow-clip', className)} data-layout="app-media-header">
	<!-- Base wash while the image loads, or when it fails. -->
	<div class="absolute inset-0 bg-neutral-900" aria-hidden="true"></div>
	{#if src != null && !imageFailed}
		<img
			{src}
			alt=""
			class={cn(
				'absolute inset-0 size-full object-cover object-top transition-opacity duration-300',
				imageLoaded ? 'opacity-100' : 'opacity-0'
			)}
			onload={() => (loadedSrc = src)}
			onerror={() => (failedSrc = src)}
		/>
	{/if}
	<!-- Dark scrim: strong at the copy edge, lighter toward the top. -->
	<div
		class="absolute inset-0 bg-linear-to-t from-black/80 via-black/50 to-black/25"
		aria-hidden="true"
	></div>

	<Inline align="end" gap="md" class={cn(INSET_X_CLASS, 'absolute inset-x-0 bottom-0 z-10 py-3')}>
		{#if icon}
			<div
				class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background text-foreground shadow-md ring-1 ring-white/25"
			>
				<IconWrapper name={icon} class="size-5" />
			</div>
		{/if}
		{#if title || description}
			<Stack gap="none" grow class="min-w-0">
				{#if title}
					<h1 class="truncate text-base font-semibold tracking-tight text-white">{title}</h1>
				{/if}
				{#if description}
					<p class="truncate text-xs leading-snug text-white/80">{description}</p>
				{/if}
			</Stack>
		{/if}
		{#if actions}
			<Cluster justify="end" class="shrink-0">{@render actions()}</Cluster>
		{/if}
	</Inline>
</div>
