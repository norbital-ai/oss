<!-- The app hero above a page: the running app's banner, icon, title and actions (`AppShell` publishes them). -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Icon, cn } from '@norbital-ai/ui';
	import { INSET_X_CLASS, Cluster, Frame, Imposter, Inline, Stack } from '@norbital-ai/ui/layout';

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
<!-- The neutral background is the base wash while the image loads, or when it fails. -->
<div
	class={cn('relative h-28 shrink-0 overflow-clip bg-neutral-900', className)}
	data-layout="app-media-header"
>
	{#if src != null && !imageFailed}
		<Imposter placement="fill">
			<img
				{src}
				alt=""
				class={cn(
					'size-full object-cover object-top transition-opacity duration-300',
					imageLoaded ? 'opacity-100' : 'opacity-0'
				)}
				onload={() => (loadedSrc = src)}
				onerror={() => (failedSrc = src)}
			/>
		</Imposter>
	{/if}
	<!-- Dark scrim: strong at the copy edge, lighter toward the top; the copy sits on its bottom edge. -->
	<Imposter placement="fill" class="bg-linear-to-t from-black/80 via-black/50 to-black/25">
		<Stack gap="none" justify="end" fill>
			<Inline align="end" justify="between" gap="md" class={cn(INSET_X_CLASS, 'py-3')}>
				{#if icon}
					<Frame
						ratio="square"
						shrink={false}
						class="size-11 rounded-xl bg-background text-foreground shadow-md ring-1 ring-white/25"
					>
						<Icon name={icon} class="size-5" />
					</Frame>
				{/if}
				{#if title || description}
					<Stack gap="none" grow class="min-w-0">
						{#if title}
							<h1 class="truncate text-base font-semibold tracking-tight text-white">{title}</h1>
						{/if}
						{#if description}
							<p class="line-clamp-2 text-xs leading-snug text-white/80 sm:line-clamp-1">{description}</p>
						{/if}
					</Stack>
				{/if}
				{#if actions}
					<!-- dark tokens: the actions sit on the scrim, never on the light page. `text-foreground` too: a control that sets
					     no colour (a picker's value, an input's text) inherits the page's computed dark text, not the scope's token -->
					<Cluster justify="end" shrink={false} class="dark text-foreground">{@render actions()}</Cluster>
				{/if}
			</Inline>
		</Stack>
	</Imposter>
</div>
