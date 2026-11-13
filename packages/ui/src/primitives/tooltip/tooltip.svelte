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
	import type { SnakeProps } from '../bits.js';

	type ContentProps = ComponentProps<typeof Content>;

	let {
		delay_duration = 100,
		disabled = false,
		ignore_non_keyboard_focus = false,
		side = 'top',
		side_offset = 0,
		align,
		avoid_collisions = true,
		collision_padding = 8,
		text,
		content_class,
		arrow_classes,
		trigger,
		content,
		on_open_change,
		on_open_change_complete,
		disable_hoverable_content,
		disable_close_on_trigger_click,
		trigger_id,
		...rootProps
	}: {
		/** Hover open delay in ms. */
		delay_duration?: number;
		/** When true, renders the trigger without a tooltip. */
		disabled?: boolean;
		/**
		 * When true, focus from dialog autofocus / mouse click does not open the tooltip —
		 * only keyboard focus does.
		 */
		ignore_non_keyboard_focus?: boolean;
		/** The trigger's side it opens on; default `top`. */
		side?: ContentProps['side'] | undefined;
		/** The gap from the trigger, in px; default 0. */
		side_offset?: ContentProps['side_offset'];
		/** Its alignment along that side: `start`, `center` or `end`. */
		align?: ContentProps['align'] | undefined;
		/**
		 * Let Floating UI flip/shift the content to keep it on screen. Bits UI defaults this to
		 * `true`, but leaves `collision_padding` at `0`; we default to an 8px gutter instead.
		 *
		 * Collision handling only *moves* the content — it never shrinks it. Rich tooltip bodies
		 * must still cap their own height, or they overflow the viewport no matter what.
		 */
		avoid_collisions?: ContentProps['avoid_collisions'];
		/** The viewport gutter kept while avoiding collisions, in px; default 8. */
		collision_padding?: ContentProps['collision_padding'];
		/** Simple string body. Prefer `content` for richer markup. */
		text?: string | undefined;
		/** Classes on the content surface (a wider cap, another surface). */
		content_class?: string;
		/** Text-color class for the SVG arrow; match this when overriding the content surface. */
		arrow_classes?: string;
		/** The element it describes; spread the given `props` onto it. Rendered alone without a body or when `disabled`. */
		trigger: Snippet<[{ props: Record<string, unknown> }]>;
		/** A rich body, in place of `text`. */
		content?: Snippet;
		/** Called as it opens or closes. */
		on_open_change?: TooltipPrimitive.RootProps['onOpenChange'];
		/** Called once the open or close animation finishes. */
		on_open_change_complete?: TooltipPrimitive.RootProps['onOpenChangeComplete'];
	} & SnakeProps<Omit<TooltipPrimitive.RootProps, 'children' | 'onOpenChange' | 'onOpenChangeComplete'>, {
		delay_duration: 'delayDuration';
		ignore_non_keyboard_focus: 'ignoreNonKeyboardFocus';
		/** `true`: the tooltip closes as the pointer leaves the trigger, even onto the tooltip itself. */
		disable_hoverable_content: 'disableHoverableContent';
		/** `true`: clicking the trigger leaves an open tooltip open. */
		disable_close_on_trigger_click: 'disableCloseOnTriggerClick';
		/** The trigger element's id, for a trigger rendered elsewhere. */
		trigger_id: 'triggerId';
	}> = $props();

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
		{on_open_change}
		{on_open_change_complete}
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
			{side_offset}
			{align}
			{avoid_collisions}
			{collision_padding}
			trap_focus={false}
			on_open_auto_focus={(e: Event) => e.preventDefault()}
			class={cn(
				'px-3 py-1.5 text-xs text-balance',
				// repository-health:allow UI25 -- pass-through of the caller's `content_class` prop; its tokens are literal at the call site
				content_class,
				// after the caller's: a desktop cap such as `max-w-96` is wider than a phone
				'max-w-[min(20rem,calc(100vw-1rem))]'
			)}
		>
			{@render body()}
		</Popover.Content>
	</Popover.Root>
{:else}
	<TooltipPrimitive.Provider delayDuration={delay_duration} ignoreNonKeyboardFocus={ignore_non_keyboard_focus}>
		<TooltipPrimitive.Root
			{...rootProps}
			ignoreNonKeyboardFocus={ignore_non_keyboard_focus}
			disableHoverableContent={disable_hoverable_content}
			disableCloseOnTriggerClick={disable_close_on_trigger_click}
			triggerId={trigger_id}
			onOpenChange={on_open_change}
			onOpenChangeComplete={on_open_change_complete}>
			<TooltipPrimitive.Trigger>
				{#snippet child({ props })}
					{@render trigger({ props })}
				{/snippet}
			</TooltipPrimitive.Trigger>
			<Content
				{side}
				{side_offset}
				{align}
				{avoid_collisions}
				{collision_padding}
				{arrow_classes}
				class={/* repository-health:allow UI25 -- pass-through of the caller's `content_class` prop; its tokens are literal at the call site */ content_class}
			>
				{@render body()}
			</Content>
		</TooltipPrimitive.Root>
	</TooltipPrimitive.Provider>
{/if}
