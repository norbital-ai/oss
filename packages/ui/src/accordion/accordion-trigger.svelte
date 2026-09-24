<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Frame, Inline } from '#lib/layout';
	import { cn, type WithoutChild } from '#lib/utils';
	import { Accordion as AccordionPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		level = 3,
		children,
		...restProps
	}: WithoutChild<AccordionPrimitive.TriggerProps> & {
		level?: AccordionPrimitive.HeaderProps['level'];
	} = $props();
</script>

<AccordionPrimitive.Header {level}>
	<AccordionPrimitive.Trigger
		data-slot="accordion-trigger"
		bind:ref
		class={cn(
			'w-full rounded-md py-3 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]_[data-slot=accordion-chevron]_svg]:rotate-180',
			className
		)}
		{...restProps}
	>
		<Inline as="span" gap="sm" justify="between">
			{@render children?.()}
			<Frame
				as="span"
				ratio="square"
				shrink={false}
				data-slot="accordion-chevron"
				class="pointer-events-none size-4"
				aria-hidden="true"
			>
				<Icon
					icon="lucide:chevron-down"
					class="size-4 text-muted-foreground transition-transform duration-200"
				/>
			</Frame>
		</Inline>
	</AccordionPrimitive.Trigger>
</AccordionPrimitive.Header>
