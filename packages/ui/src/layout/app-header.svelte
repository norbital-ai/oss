<!--
@component
	The app hero above a page: the running app's banner, icon, title and actions (`AppShell` publishes them).
	`compact` is the phone's one top bar: the same identity in a slim strip with the shell's own controls
	(`leading`, `trailing`) and the page's scope controls in a lane beneath it.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';

	/** The shared app banner, identity and scope controls used by workspace and host shells. */
	export interface AppHeaderProps {
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
		actions?: Snippet | undefined;
		/** The phone's top bar: one slim row, the banner behind it, the actions in a scrolling lane below. */
		compact?: boolean;
		/** The accessible name of the compact actions lane. */
		actionsLabel?: string;
		/** Shell controls before the identity (the navigation button). Compact only. */
		leading?: Snippet;
		/** Shell controls after the identity (the bell, Norbius). Compact only. */
		trailing?: Snippet;
		class?: string;
	}
</script>

<script lang="ts">
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import Image from '../primitives/image/image.svelte';
	import { cn } from '../primitives/utils.js';
	import { INSET_X_CLASS } from './layout.shared.js';
	import Cluster from './cluster.svelte';
	import Frame from './frame.svelte';
	import Imposter from './imposter.svelte';
	import Inline from './inline.svelte';
	import Scroll from './scroll.svelte';
	import Stack from './stack.svelte';

	let {
		src = null,
		icon = null,
		title = null,
		description = null,
		actions,
		compact = false,
		actionsLabel = 'Page scope',
		leading,
		trailing,
		class: className
	}: AppHeaderProps = $props();

	// the copy sits on the dark scrim on the desktop hero always, on the phone's bar only over a banner
	const scrim = $derived(!compact || src != null);
	// dark tokens for controls on the scrim. `text-foreground` too: a control that sets no colour (a picker's
	// value, an input's text) inherits the page's computed dark text, not the scope's token
	const onScrim = $derived(scrim && 'dark text-foreground');
</script>

{#snippet banner()}
	{#if src != null}
		<Imposter placement="fill" layer="under">
			<Image
				{src}
				alt=""
				loading="eager"
				fetchpriority="high"
				class="size-full"
				imageClass="size-full object-cover object-center"
			/>
		</Imposter>
	{/if}
{/snippet}

{#snippet identity()}
	{#if icon}
		<Frame
			ratio="square"
			class={cn(
				compact ? 'size-8 rounded-lg' : 'size-11 rounded-xl',
				scrim
					? 'bg-background text-foreground shadow-md ring-1 ring-white/25'
					: 'bg-muted text-foreground'
			)}
		>
			<Icon name={icon} class={compact ? 'size-4' : 'size-5'} />
		</Frame>
	{/if}
	{#if title || description}
		<Stack gap="none" size="fill" class="min-w-0">
			{#if title}
				<h1
					class={cn(
						'truncate',
						compact ? 'text-sm font-medium' : 'text-base font-semibold tracking-tight',
						scrim ? 'text-white' : 'text-foreground'
					)}
				>
					{title}
				</h1>
			{/if}
			{#if description}
				<p
					class={cn(
						'text-xs leading-snug',
						compact ? 'truncate' : 'line-clamp-2 sm:line-clamp-1',
						scrim ? 'text-white/80' : 'text-muted-foreground'
					)}
				>
					{description}
				</p>
			{/if}
		</Stack>
	{/if}
{/snippet}

{#if compact}
	<!--
		One bar: safe-area insets on its own edges, the banner and scrim behind the whole strip (status bar
		included), 44px controls either side of the identity, then the page's scope controls. Pickers shed
		their authored widths in the lane so each reads as a chip; their popovers and sheets are unchanged.
	-->
	<header
		class={cn(
			'relative shrink-0 overflow-clip pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))]',
			scrim ? 'bg-neutral-900' : 'border-b bg-background',
			className
		)}
		data-layout="app-media-header"
		data-slot="app-header"
		data-compact
	>
		{@render banner()}
		{#if src != null}
			<Imposter
				placement="fill"
				layer="under"
				class="bg-linear-to-b from-black/25 via-black/45 to-black/75"
			/>
		{/if}
		<Stack gap="none" class="relative">
			<Inline
				gap="sm"
				justify="between"
				class={cn('min-h-11 py-0.5', leading === undefined && 'pl-2')}
			>
				{#if leading}<Inline gap="none" class={cn(onScrim)}>{@render leading()}</Inline>{/if}
				{@render identity()}
				{#if trailing}<Inline gap="none" class={cn(onScrim)}>{@render trailing()}</Inline>{/if}
			</Inline>
			{#if actions}
				<Scroll
					axis="x"
					layout="inline"
					gap="xs"
					name={actionsLabel}
					class={cn(
						'px-2 pb-2 *:shrink-0 [&_button]:h-10 [&_button]:px-3 [&_button]:text-sm [&_[role=combobox]]:w-auto [&_[role=combobox]]:max-w-44',
						onScrim
					)}
					data-app-actions
				>
					{@render actions()}
				</Scroll>
			{/if}
		</Stack>
	</header>
{:else}
	<!--
		Airbnb-style photo card chrome: full-bleed media, bottom-weighted dark scrim,
		identity copy on the scrim. Banner art never owns text contrast.
	-->
	<!-- The neutral background is the base wash while the image loads, or when it fails. -->
	<div
		class={cn('relative h-28 shrink-0 overflow-clip bg-neutral-900', className)}
		data-layout="app-media-header"
	>
		{@render banner()}
		<!-- Dark scrim: strong at the copy edge, lighter toward the top; the copy sits on its bottom edge. -->
		<Imposter placement="fill" class="bg-linear-to-t from-black/80 via-black/50 to-black/25">
			<Stack gap="none" justify="end" size="fill">
				<Inline align="end" justify="between" gap="md" class={cn(INSET_X_CLASS, 'py-3')}>
					{@render identity()}
					{#if actions}
						<Cluster justify="end" class={cn(onScrim)} data-app-actions>{@render actions()}</Cluster
						>
					{/if}
				</Inline>
			</Stack>
		</Imposter>
	</div>
{/if}
