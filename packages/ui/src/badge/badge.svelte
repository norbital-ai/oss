<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	// Extended badge variants with additional options.
	export const badgeVariants = tv({
		base: 'focus:ring-ring inline-flex items-center rounded-full border px-2 py-0.5 text-xs leading-4 font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2',
		variants: {
			variant: {
				default: 'bg-brand-100 text-brand-700 hover:bg-brand-200 border-brand-100',
				brand: 'bg-brand-100 text-brand-700 hover:bg-brand-200 border-brand-100',
				outline: 'text-secondary-foreground hover:bg-secondary/80 border-secondary',
				destructive:
					'bg-destructive text-destructive-foreground hover:bg-destructive/80 border-destructive',
				info: 'bg-info text-info-foreground hover:bg-info/80 border-info',
				success: 'bg-success text-success-foreground hover:bg-success/80 border-success',
				warning: 'bg-warning text-warning-foreground hover:bg-warning/80 border-warning'
			}
		},
		defaultVariants: {
			variant: 'default'
		}
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAnchorAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = 'default',
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		variant?: BadgeVariant;
	} = $props();
</script>

<svelte:element
	this={href ? 'a' : 'span'}
	bind:this={ref}
	{href}
	class={cn(badgeVariants({ variant }), className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
