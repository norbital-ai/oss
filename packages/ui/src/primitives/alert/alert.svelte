<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	export const alert_variants = tv({
		base: '[&>svg]:text-foreground relative w-full rounded-lg border [&>svg+div]:translate-y-[-3px] [&>svg]:absolute',
		variants: {
			/** `sm` sits inside a card or panel: tighter padding, the same icon inset. */
			size: {
				default: 'p-4 [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7',
				sm: 'px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6'
			},
			variant: {
				default: 'bg-background text-foreground',
				destructive:
					'border-tone-destructive-border bg-tone-destructive-bg text-tone-destructive-text [&>svg]:text-tone-destructive-text',
				success:
					'border-tone-success-border bg-tone-success-bg text-tone-success-text [&>svg]:text-tone-success-text',
				warning:
					'border-tone-warning-border bg-tone-warning-bg text-tone-warning-text [&>svg]:text-tone-warning-text',
				info: 'border-tone-info-border bg-tone-info-bg text-tone-info-text [&>svg]:text-tone-info-text',
				secondary:
					'border-tone-neutral-border bg-tone-neutral-bg text-foreground [&>svg]:text-tone-neutral-text',
				loading:
					'border-tone-info-border bg-tone-info-bg text-tone-info-text [&>svg]:animate-spin [&>svg]:text-tone-info-text'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type AlertVariant = VariantProps<typeof alert_variants>['variant'];
	export type AlertSize = VariantProps<typeof alert_variants>['size'];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from '../utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'default',
		size = 'default',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		variant?: AlertVariant;
		size?: AlertSize;
	} = $props();
</script>

<!-- repository-health:allow UI25 -- the alert recipe is a tailwind-variants `tv()` whose literal classes live in the module script -->
<div bind:this={ref} class={cn(alert_variants({ variant, size }), className)} {...restProps} role="alert">
	{@render children?.()}
</div>
