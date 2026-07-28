<script lang="ts">
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import type { ComponentProps, Snippet } from 'svelte';
	import Content from './tooltip-content.svelte';

	type ContentProps = ComponentProps<typeof Content>;

	let {
		delayDuration = 100,
		disabled = false,
		ignoreNonKeyboardFocus = false,
		side = 'top',
		sideOffset = 0,
		align,
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
		side?: ContentProps['side'];
		sideOffset?: ContentProps['sideOffset'];
		align?: ContentProps['align'];
		/** Simple string body. Prefer `content` for richer markup. */
		text?: string;
		contentClass?: string;
		/** Text-color class for the SVG arrow; match this when overriding the content surface. */
		arrowClasses?: string;
		trigger: Snippet<[{ props: Record<string, unknown> }]>;
		content?: Snippet;
	} & Omit<TooltipPrimitive.RootProps, 'children' | 'ignoreNonKeyboardFocus'> = $props();

	const hasBody = $derived(Boolean(text) || Boolean(content));
</script>

{#if disabled || !hasBody}
	{@render trigger({ props: {} })}
{:else}
	<TooltipPrimitive.Provider {delayDuration} {ignoreNonKeyboardFocus}>
		<TooltipPrimitive.Root {...rootProps} {ignoreNonKeyboardFocus}>
			<TooltipPrimitive.Trigger>
				{#snippet child({ props })}
					{@render trigger({ props })}
				{/snippet}
			</TooltipPrimitive.Trigger>
			<Content {side} {sideOffset} {align} {arrowClasses} class={contentClass}>
				{#if content}
					{@render content()}
				{:else}
					<p>{text}</p>
				{/if}
			</Content>
		</TooltipPrimitive.Root>
	</TooltipPrimitive.Provider>
{/if}
