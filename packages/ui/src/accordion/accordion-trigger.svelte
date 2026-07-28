<script lang="ts">
	import Icon from '@iconify/svelte';
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

<AccordionPrimitive.Header {level} class="flex">
	<AccordionPrimitive.Trigger
		data-slot="accordion-trigger"
		bind:ref
		class={cn(
			'flex flex-1 items-center justify-between gap-3 rounded-md py-3 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>span[data-slot=accordion-chevron]_svg]:rotate-180',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		<span
			data-slot="accordion-chevron"
			class="pointer-events-none inline-flex size-4 shrink-0 items-center justify-center"
			aria-hidden="true"
		>
			<Icon
				icon="lucide:chevron-down"
				class="size-4 text-muted-foreground transition-transform duration-200"
			/>
		</span>
	</AccordionPrimitive.Trigger>
</AccordionPrimitive.Header>
