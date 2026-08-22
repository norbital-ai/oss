<script lang="ts" module>
	import { cn } from '#lib/utils';
	import { mergeProps } from 'bits-ui';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { type VariantProps, tv } from 'tailwind-variants';

	export const buttonVariants = tv({
		base: 'focus-visible:ring-ring inline-flex items-center justify-center whitespace-nowrap rounded-sm text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50',
		variants: {
			variant: {
				default: 'bg-primary text-primary-foreground hover:bg-primary/90',
				destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
				outline: 'border-input bg-background hover:bg-accent hover:text-accent-foreground border',
				secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
				ghost: 'hover:bg-accent hover:text-accent-foreground',
				link: 'text-primary underline-offset-4 hover:underline focus-visible:ring-0 focus-visible:outline-none focus-visible:underline focus-visible:decoration-ring focus-visible:decoration-2 focus-visible:underline-offset-4'
			},
			size: {
				default: 'h-8 px-4 py-2',
				sm: 'h-7 rounded-md px-3',
				lg: 'h-9 rounded-md px-8',
				icon: 'h-8 w-8'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
			readonly?: boolean; // Prevents interactions but keeps normal styling
			hint?: string; // Tooltip hint
			disabledMessage?: string; // Tooltip message when disabled
			readonlyMessage?: string; // Tooltip message when readonly
		};
</script>

<script lang="ts">
	import { Tooltip } from '#lib/tooltip';

	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
		children,
		disabled = false,
		readonly = false,
		hint,
		disabledMessage,
		readonlyMessage,
		onclick,
		...restProps
	}: ButtonProps = $props();

	// Determine if interactions should be prevented
	const isInteractive = $derived(!disabled && !readonly);

	// Determine what tooltip message to show
	const tooltipMessage = $derived.by(() => {
		if (disabled && disabledMessage) {
			return disabledMessage;
		}
		if (readonly && readonlyMessage) {
			return readonlyMessage;
		}
		return hint;
	});

	// Should show tooltip if any message is available
	const shouldShowTooltip = $derived(Boolean(tooltipMessage));

	// Handle click events - prevent if disabled or readonly
	function handleClick(event: MouseEvent): boolean {
		if (!isInteractive) {
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	}

	const handleButtonClick = (
		event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }
	) => {
		if (handleClick(event)) onclick?.(event);
	};

	const handleAnchorClick = (
		event: MouseEvent & { currentTarget: EventTarget & HTMLAnchorElement }
	) => {
		if (handleClick(event)) onclick?.(event);
	};

	// Compute final classes - readonly doesn't get disabled styles
	const computedClass = $derived(
		cn(
			buttonVariants({ variant, size }),
			{
				// Readonly gets pointer-events-none but no opacity change
				'pointer-events-none': readonly && !disabled
				// Keep the default disabled styles when actually disabled
			},
			className
		)
	);
</script>

{#snippet Button({ props }: { props?: Record<string, unknown> })}
	{#if href}
		{@const mergedProps = mergeProps(
			{
				class: computedClass,
				onclick: handleAnchorClick,
				'aria-disabled': disabled || readonly,
				...restProps
			},
			props
		)}
		<a bind:this={ref} {...mergedProps} href={isInteractive ? href : undefined}>
			{@render children?.()}
		</a>
	{:else}
		{@const mergedProps = mergeProps(
			{
				class: computedClass,
				onclick: handleButtonClick,
				'aria-disabled': disabled || readonly,
				...restProps
			},
			props
		)}
		<button bind:this={ref} {...mergedProps} {type} {disabled}>
			{@render children?.()}
		</button>
	{/if}
{/snippet}

{#if shouldShowTooltip}
	<Tooltip text={tooltipMessage} align="start" delayDuration={100}>
		{#snippet trigger({ props })}
			{@render Button({ props })}
		{/snippet}
	</Tooltip>
{:else}
	{@render Button({})}
{/if}
