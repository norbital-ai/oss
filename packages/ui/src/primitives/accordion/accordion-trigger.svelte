<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { Frame, Inline } from '../../layout/index.js';
	import { cn, type WithElementRef, type WithoutChild } from '../utils.js';
	import { get_accordion_item, get_accordion_root } from './context.js';

	let {
		ref = $bindable(null),
		class: className,
		level = 3,
		children,
		onclick,
		onfocus,
		...restProps
	}: WithoutChild<WithElementRef<HTMLButtonAttributes, HTMLButtonElement>> & {
		/** Heading level wrapping the trigger (`1`–`6`, default `3`). */
		level?: 1 | 2 | 3 | 4 | 5 | 6;
		/** Trigger label content. */
		children?: Snippet;
	} = $props();

	const root = get_accordion_root();
	const item = get_accordion_item();
	const open = $derived(item?.open ?? false);
	const disabled = $derived(Boolean(restProps.disabled) || (item?.disabled ?? false));
</script>

<div role="heading" aria-level={level}>
	<button
		type="button"
		id={item?.trigger_id}
		aria-expanded={open}
		aria-controls={item?.content_id}
		data-slot="accordion-trigger"
		data-state={open ? 'open' : 'closed'}
		{disabled}
		bind:this={ref}
		{@attach (el) => (item !== undefined && root !== undefined ? root.trigger_attachment(item.value)(el) : undefined)}
		class={cn(
			'w-full rounded-control py-3 text-left text-sm font-medium transition-colors outline-none hover:underline focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]_[data-slot=accordion-chevron]_svg]:rotate-180',
			className
		)}
		{...restProps}
		onfocus={(e) => {
			if (item !== undefined) root?.on_trigger_focus(item.value);
			onfocus?.(e);
		}}
		onclick={(e) => {
			item?.toggle();
			onclick?.(e);
		}}
	>
		<Inline as="span" gap="sm" justify="between">
			{@render children?.()}
			<Frame
				as="span"
				ratio="square"
				data-slot="accordion-chevron"
				class="pointer-events-none size-4"
				aria-hidden="true"
			>
				<Icon
					icon="lucide:chevron-down"
					class="size-4 text-muted-foreground transition-transform duration-[var(--motion-base)] ease-spring-snappy motion-reduce:transition-none"
				/>
			</Frame>
		</Inline>
	</button>
</div>
