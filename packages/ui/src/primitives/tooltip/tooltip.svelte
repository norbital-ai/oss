<!--
@component
A tooltip on hover or focus of its trigger, with a text or snippet body; where nothing hovers, a tap opens it as a popover.
-->
<script lang="ts">
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import type { ComponentProps, Snippet } from 'svelte';
	import * as Popover from '../popover/index.js';
	import { cn, noHover } from '../utils.js';
	import Content from './tooltip-content.svelte';

	type ContentProps = ComponentProps<typeof Content>;

	let {
		delayDuration = 100,
		disabled = false,
		ignoreNonKeyboardFocus = false,
		side = 'top',
		sideOffset = 0,
		align,
		avoidCollisions = true,
		collisionPadding = 8,
		text,
		contentClass,
		arrowClasses,
		trigger,
		content,
		...rootProps
	}: {
		/** Hover open delay in ms. */
		delayDuration?: number;
		/** When true, renders the trigger without a tooltip. */
		disabled?: boolean;
		/**
		 * When true, focus from dialog autofocus / mouse click does not open the tooltip —
		 * only keyboard focus does.
		 */
		ignoreNonKeyboardFocus?: boolean;
		side?: ContentProps['side'] | undefined;
		sideOffset?: ContentProps['sideOffset'];
		align?: ContentProps['align'] | undefined;
		/**
		 * Let Floating UI flip/shift the content to keep it on screen. Bits UI defaults this to
		 * `true`, but leaves `collisionPadding` at `0`; we default to an 8px gutter instead.
		 *
		 * Collision handling only *moves* the content — it never shrinks it. Rich tooltip bodies
		 * must still cap their own height, or they overflow the viewport no matter what.
		 */
		avoidCollisions?: ContentProps['avoidCollisions'];
		collisionPadding?: ContentProps['collisionPadding'];
		/** Simple string body. Prefer `content` for richer markup. */
		text?: string | undefined;
		contentClass?: string;
		/** Text-color class for the SVG arrow; match this when overriding the content surface. */
		arrowClasses?: string;
		trigger: Snippet<[{ props: Record<string, unknown> }]>;
		content?: Snippet;
	} & Omit<TooltipPrimitive.RootProps, 'children' | 'ignoreNonKeyboardFocus'> = $props();

	const hasBody = $derived(Boolean(text) || Boolean(content));
	let tapped = $state(false);
	const open = $derived(rootProps.open ?? tapped);
</script>

{#snippet body()}
	{#if content}
		{@render content()}
	{:else}
		<p>{text}</p>
	{/if}
{/snippet}

{#if disabled || !hasBody}
	{@render trigger({ props: {} })}
{:else if noHover.current}
	<Popover.Root
		bind:open={() => open, (next) => (tapped = next)}
		onOpenChange={rootProps.onOpenChange}
	>
		<Popover.Trigger>
			{#snippet child({ props })}
				<!-- no box of its own, until a disabled trigger lets the tap through to it. Enter and Space stay the trigger's:
				     they click it, and the click opens this too. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<span
					class="contents has-[>:disabled,>[aria-disabled=true]]:inline-flex [&>:disabled]:pointer-events-none"
					onclick={(e) => {
						if (e.target === e.currentTarget) tapped = !open;
					}}
				>
					{@render trigger({ props: { ...props, onkeydown: undefined } })}
				</span>
			{/snippet}
		</Popover.Trigger>
		<!-- a hint: focus stays where it is, or a tap on a field's hint would blur the field -->
		<Popover.Content
			{side}
			{sideOffset}
			{align}
			{avoidCollisions}
			{collisionPadding}
			trapFocus={false}
			onOpenAutoFocus={(e: Event) => e.preventDefault()}
			class={cn(
				'px-3 py-1.5 text-xs text-balance',
				// repository-health:allow UI25 -- pass-through of the caller's `contentClass` prop; its tokens are literal at the call site
				contentClass,
				// after the caller's: a desktop cap such as `max-w-96` is wider than a phone
				'max-w-[min(20rem,calc(100vw-1rem))]'
			)}
		>
			{@render body()}
		</Popover.Content>
	</Popover.Root>
{:else}
	<TooltipPrimitive.Provider {delayDuration} {ignoreNonKeyboardFocus}>
		<TooltipPrimitive.Root {...rootProps} {ignoreNonKeyboardFocus}>
			<TooltipPrimitive.Trigger>
				{#snippet child({ props })}
					{@render trigger({ props })}
				{/snippet}
			</TooltipPrimitive.Trigger>
			<Content
				{side}
				{sideOffset}
				{align}
				{avoidCollisions}
				{collisionPadding}
				{arrowClasses}
				class={/* repository-health:allow UI25 -- pass-through of the caller's `contentClass` prop; its tokens are literal at the call site */ contentClass}
			>
				{@render body()}
			</Content>
		</TooltipPrimitive.Root>
	</TooltipPrimitive.Provider>
{/if}
