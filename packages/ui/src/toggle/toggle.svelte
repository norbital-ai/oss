<script lang="ts" module>
	import dedent from 'dedent';
	import { type VariantProps, tv } from 'tailwind-variants';

	export const toggleVariants = tv({
		base: dedent`
			ring-offset-background hover:bg-muted hover:text-muted-foreground focus-visible:ring-ring
			inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium
			transition-all duration-100 ease-[cubic-bezier(0.4,0,0.2,1)]
			focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
			disabled:pointer-events-none disabled:opacity-50
			[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-100
			[&>*]:transition-transform [&>*]:duration-100
		`,
		variants: {
			variant: {
				default: dedent`
					bg-transparent border border-transparent
					hover:bg-muted/60
					data-[state=on]:bg-accent data-[state=on]:text-accent-foreground
					data-[state=on]:border-accent
					data-[state=on]:shadow-lg data-[state=on]:shadow-accent/30
					data-[state=on]:[&_svg]:scale-110
					data-[state=on]:[&>*]:scale-105
					data-[state=on]:hover:bg-accent/90
					active:[&_svg]:scale-90 active:[&>*]:scale-95
				`,
				outline: dedent`
					border-input hover:bg-accent hover:text-accent-foreground
					border-2 bg-transparent
					hover:border-accent
					data-[state=on]:bg-accent data-[state=on]:text-accent-foreground
					data-[state=on]:border-accent data-[state=on]:border-2
					data-[state=on]:shadow-lg data-[state=on]:shadow-accent/30
					data-[state=on]:[&_svg]:scale-110
					data-[state=on]:[&>*]:scale-105
					data-[state=on]:hover:bg-accent/90 data-[state=on]:hover:border-accent/90
					active:[&_svg]:scale-90 active:[&>*]:scale-95
				`,
				filled: dedent`
					bg-muted text-muted-foreground border border-transparent
					hover:bg-muted/80
					data-[state=on]:bg-accent data-[state=on]:text-accent-foreground
					data-[state=on]:border-accent
					data-[state=on]:shadow-lg data-[state=on]:shadow-accent/35
					data-[state=on]:[&_svg]:scale-110
					data-[state=on]:[&>*]:scale-105
					data-[state=on]:hover:bg-accent/90
					active:[&_svg]:scale-90 active:[&>*]:scale-95
				`,
				ghost: dedent`
					border border-transparent
					hover:bg-accent hover:text-accent-foreground
					data-[state=on]:bg-accent data-[state=on]:text-accent-foreground
					data-[state=on]:shadow-md data-[state=on]:shadow-accent/25
					data-[state=on]:[&_svg]:scale-110
					data-[state=on]:[&>*]:scale-105
					data-[state=on]:hover:bg-accent/90
					active:[&_svg]:scale-90 active:[&>*]:scale-95
				`
			},
			size: {
				default: 'h-8 px-4 py-2',
				sm: 'h-9 rounded-md px-3',
				lg: 'h-11 rounded-md px-8',
				icon: 'h-6 w-6'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ToggleVariant = VariantProps<typeof toggleVariants>['variant'];
	export type ToggleSize = VariantProps<typeof toggleVariants>['size'];
	export type ToggleVariants = VariantProps<typeof toggleVariants>;
</script>

<script lang="ts">
	import { Tooltip } from '#lib/tooltip';
	import { cn } from '#lib/utils';
	import { mergeProps, Toggle as TogglePrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		pressed = $bindable(false),
		class: className,
		size = 'default',
		variant = 'default',
		icon = 'lucide:construction',
		hint,
		disabledReason,
		disabled = false,
		children,
		...restProps
	}: TogglePrimitive.RootProps & {
		variant?: ToggleVariant;
		size?: ToggleSize;
		icon?: string;
		hint?: string;
		disabledReason?: string;
	} = $props();

	// Determine what tooltip message to show
	const tooltipMessage = $derived.by(() => {
		if (disabled && disabledReason) {
			return disabledReason;
		}
		return hint;
	});

	// Should show tooltip if hint is provided OR if disabled with disabledReason
	const shouldShowTooltip = $derived.by(() => Boolean(hint || (disabled && disabledReason)));
</script>

{#snippet ToggleComponent({ props }: { props?: Record<string, unknown> })}
	<TogglePrimitive.Root
		bind:ref
		bind:pressed
		{disabled}
		class={cn(toggleVariants({ variant, size }), className)}
		{...mergeProps(restProps, props)}
		aria-label={restProps['aria-label'] || 'Toggle edit mode'}
	>
		{@render children?.({ pressed })}
	</TogglePrimitive.Root>
{/snippet}

{#if shouldShowTooltip}
	<Tooltip text={tooltipMessage} align="start" delayDuration={100}>
		{#snippet trigger({ props })}
			{@render ToggleComponent({ props })}
		{/snippet}
	</Tooltip>
{:else}
	{@render ToggleComponent({})}
{/if}
