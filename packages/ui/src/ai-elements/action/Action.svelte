<script lang="ts">
	import { Shimmer } from '../shimmer';
	import { Button, type ButtonProps } from '#lib/button';
	import { Tooltip } from '#lib/tooltip';
	import { cn } from '#lib/utils';

	export type ActionProps = ButtonProps & {
		tooltip?: string;
		label?: string;
		/** Enable shimmer effect on the label/tooltip text */
		shimmer?: boolean;
	};

	let {
		tooltip,
		children,
		label,
		class: className,
		variant = 'ghost',
		size = 'sm',
		shimmer = false,
		...restProps
	}: ActionProps = $props();

	let buttonClasses = $derived(
		cn('relative size-7 p-0.5 text-muted-foreground hover:text-foreground', className)
	);
</script>

{#if tooltip}
	<Tooltip delayDuration={150} side="top" sideOffset={8}>
		{#snippet trigger({ props })}
			<Button class={buttonClasses} {size} type="button" {variant} {...restProps} {...props}>
				{@render children?.()}
				<span class="sr-only">{label || tooltip}</span>
			</Button>
		{/snippet}
		{#snippet content()}
			{#if shimmer}
				<Shimmer content_length={tooltip.length}>
					{tooltip}
				</Shimmer>
			{:else}
				<p>{tooltip}</p>
			{/if}
		{/snippet}
	</Tooltip>
{:else}
	<Button class={buttonClasses} {size} type="button" {variant} {...restProps}>
		{@render children?.()}
		<span class="sr-only">{label || tooltip}</span>
	</Button>
{/if}
