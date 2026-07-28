<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	export const alertVariants = tv({
		base: '[&>svg]:text-foreground relative w-full rounded-lg border p-4 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7',
		variants: {
			variant: {
				default: 'bg-background text-foreground',
				destructive:
					'border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive',
				success:
					'border-success/50 text-success bg-success/10 dark:bg-success/30 [&>svg]:text-success',
				warning:
					'border-warning/50 text-warning-foreground bg-warning/10 dark:bg-warning/30 [&>svg]:text-warning',
				info: 'border-info/50 text-info bg-info/10 dark:bg-info/30 [&>svg]:text-info',
				secondary: 'border-border bg-muted text-foreground [&>svg]:text-muted-foreground',
				loading:
					'border-info/50 text-info bg-info/10 dark:bg-info/30 [&>svg]:animate-spin [&>svg]:text-info'
			},
			size: {
				sm: 'p-3 text-sm',
				default: 'p-4',
				lg: 'p-6 text-lg'
			},
			rounded: {
				none: 'rounded-none',
				default: 'rounded-lg',
				full: 'rounded-xl'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default',
			rounded: 'default'
		}
	});

	export type AlertVariant = VariantProps<typeof alertVariants>['variant'];
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'default',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		variant?: AlertVariant;
	} = $props();
</script>

<div bind:this={ref} class={cn(alertVariants({ variant }), className)} {...restProps} role="alert">
	{@render children?.()}
</div>
