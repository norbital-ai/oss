<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';
	const inputGroupAddonVariants = tv({
		variants: {
			align: {
				'inline-start': 'order-first pl-3 has-[>button]:ml-[-0.45rem] has-[>kbd]:ml-[-0.35rem]',
				'inline-end': 'order-last pr-3 has-[>button]:mr-[-0.45rem] has-[>kbd]:mr-[-0.35rem]',
				'block-start':
					'[.border-b]:pb-3 order-first w-full px-3 pt-3 group-has-[>input]/input-group:pt-2.5',
				'block-end':
					'[.border-t]:pt-3 order-last w-full px-3 pb-3 group-has-[>input]/input-group:pb-2.5'
			}
		},
		defaultVariants: {
			align: 'inline-start'
		}
	});

	type InputGroupAddonAlign = VariantProps<typeof inputGroupAddonVariants>['align'];
</script>

<script lang="ts">
	import { Inline } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		align = 'inline-start',
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		align?: InputGroupAddonAlign;
	} = $props();
</script>

<Inline
	justify={align === 'block-start' || align === 'block-end' ? 'start' : 'center'}
	shrink={false}
	role="group"
	data-slot="input-group-addon"
	data-align={align}
	class={cn(
		"h-auto cursor-text py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4",
		inputGroupAddonVariants({ align }),
		className
	)}
	onclick={(e) => {
		if ((e.target as HTMLElement).closest('button')) {
			return;
		}
		e.currentTarget.parentElement?.querySelector('input')?.focus();
	}}
	{...restProps}
	{@attach (node: HTMLElement) => {
		ref = node as typeof ref;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Inline>
