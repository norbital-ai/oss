<!--
@component
A small label tag in a colour variant.
-->
<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	// Extended badge variants with additional options.
	export const badge_variants = tv({
		base: 'focus:ring-ring focus:ring-offset-background inline-flex items-center rounded-badge border px-2 py-0.5 text-xs leading-4 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2',
		variants: {
			variant: {
				default: 'bg-brand-muted text-brand-text hover:bg-brand/15 border-brand/20',
				brand: 'bg-brand-muted text-brand-text hover:bg-brand/15 border-brand/20',
				outline: 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
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

	/** The colour variants of `Badge`. */
	export type BadgeVariant = VariantProps<typeof badge_variants>['variant'];
</script>

<script lang="ts">
	import { cn } from '../utils.js';
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
	class={/* repository-health:allow UI25 -- the badge recipe is a tailwind-variants `tv()` whose literal classes live in the module script */ cn(
		badge_variants({ variant }),
		className
	)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
