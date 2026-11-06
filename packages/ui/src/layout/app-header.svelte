<!--
@component
	The app hero above a page: the running app's banner, icon, title and actions (`AppShell` publishes them).
	`compact` is the phone's one top bar: one line holding the shell's own controls (`leading`, `trailing`), the title
	with its description behind an info button, and the page's scope controls behind one button.
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
		/** The phone's top bar: one line, the banner behind it, the description behind an info button, the actions in a popover. */
		compact?: boolean;
		/** The accessible name of the compact actions button. */
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
	import * as Popover from '../primitives/popover/index.js';
	import { cn } from '../primitives/utils.js';
	import { INSET_X_CLASS } from './layout.shared.js';
	import Cluster from './cluster.svelte';
	import Frame from './frame.svelte';
	import Imposter from './imposter.svelte';
	import Inline from './inline.svelte';
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
	// the page's actions stay mounted while the popover is shut (a scope picker owns page state): it borrows them, one
	// to a row whatever row an app laid them out in
	let shelf = $state<HTMLElement | null>(null);
	let tools = $state<HTMLElement | null>(null);
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
				// a phone's one line gives the icon's room to the lane
				compact && actions !== undefined && 'max-sm:hidden',
				scrim ? 'bg-background text-foreground ring-1 ring-border' : 'bg-muted text-foreground'
			)}
		>
			<Icon name={icon} class={compact ? 'size-4' : 'size-5'} />
		</Frame>
	{/if}
	{#if compact}
		{#if title}
			<h1
				class={cn('min-w-0 truncate text-sm font-medium', scrim ? 'text-white' : 'text-foreground')}
			>
				{title}
			</h1>
		{/if}
		{#if description}
			<Popover.Root>
				<Popover.Trigger
					aria-label={description}
					class={cn(
						'flex size-8 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
						scrim ? 'text-white/80' : 'text-muted-foreground'
					)}
				>
					<Icon name="lucide:info" class="size-4" />
				</Popover.Trigger>
				<Popover.Content align="start" maxWidth={288} class="p-3 text-sm"
					>{description}</Popover.Content
				>
			</Popover.Root>
		{/if}
	{:else if title || description}
		<Stack gap="none" size="fill" class="min-w-0">
			{#if title}
				<h1
					class={cn(
						'truncate text-base font-semibold tracking-tight',
						scrim ? 'text-white' : 'text-foreground'
					)}
				>
					{title}
				</h1>
			{/if}
			{#if description}
				<p
					class={cn(
						'line-clamp-2 text-xs leading-snug sm:line-clamp-1',
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
		One line: safe-area insets on its own edges, the banner and scrim behind the whole strip (status bar
		included), 44px controls at either end, the title, then the page's scope controls behind one button,
		so the title keeps its room.
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
		<Inline
			gap="sm"
			justify="between"
			class={cn('relative min-h-11 py-0.5', leading === undefined && 'pl-4 sm:pl-6')}
		>
			{#if leading}<Inline gap="none" class={cn(onScrim)}>{@render leading()}</Inline>{/if}
			<Inline gap="xs" size="fill" class="min-w-24">{@render identity()}</Inline>
			{#if actions}
				<Popover.Root>
					<Popover.Trigger
						aria-label={actionsLabel}
						class={cn(
							'flex size-11 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
							scrim ? 'text-white' : 'text-foreground'
						)}
						data-app-actions-trigger
					>
						<Icon name="lucide:sliders-horizontal" class="size-4" />
					</Popover.Trigger>
					<Popover.Content align="end" class="w-[min(20rem,calc(100vw-1rem))] p-2">
						<div
							{@attach (node) => {
								if (tools === null || shelf === null) return;
								const [lane, home] = [tools, shelf];
								node.append(lane);
								return () => home.append(lane);
							}}
						></div>
					</Popover.Content>
				</Popover.Root>
			{/if}
			{#if trailing}<Inline gap="none" class={cn(onScrim)}>{@render trailing()}</Inline>{/if}
		</Inline>
		{#if actions}
			<div bind:this={shelf} hidden>
				<div
					bind:this={tools}
					class="grid gap-2 *:w-full *:flex-col *:items-stretch *:*:w-full *:*:min-w-0"
					data-app-actions
				>
					{@render actions()}
				</div>
			</div>
		{/if}
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
