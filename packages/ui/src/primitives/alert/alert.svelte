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
					'border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive',
				success:
					'border-success/50 text-success bg-success/10 dark:bg-success/30 [&>svg]:text-success',
				warning:
					'border-warning/50 bg-warning/10 text-warning-foreground dark:bg-warning/30 dark:text-warning [&>svg]:text-warning',
				info: 'border-info/50 text-info bg-info/10 dark:bg-info/30 [&>svg]:text-info',
				secondary: 'border-border bg-muted text-foreground [&>svg]:text-muted-foreground',
				loading:
					'border-info/50 text-info bg-info/10 dark:bg-info/30 [&>svg]:animate-spin [&>svg]:text-info'
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
	import { cn } from '../utils.js';
	import type { WithElementRef } from 'bits-ui';
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
