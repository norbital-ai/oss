<script lang="ts">
	import { cn } from '#lib/utils';
	import { Switch as SwitchPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

	// Define a new Props type to include our custom `readonly` prop
	type Props = WithoutChildrenOrChild<SwitchPrimitive.RootProps> & {
		readonly?: boolean;
	};

	let {
		ref = $bindable(null),
		class: className,
		checked = $bindable(false),
		readonly = false, // Add readonly prop
		...restProps
	}: Props = $props();
</script>

{#if readonly}
	<div
		class={cn(
			'inline-flex h-[24px] w-[44px] shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
			// Apply colors based on the `checked` state
			checked ? 'bg-primary' : 'bg-input',
			// If disabled while readonly, apply opacity
			restProps.disabled && 'opacity-50',
			className
		)}
		aria-readonly="true"
	>
		<div
			class={cn(
				'block size-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
				// Translate the thumb based on the `checked` state
				checked ? 'translate-x-5' : 'translate-x-0'
			)}
		></div>
	</div>
{:else}
	<SwitchPrimitive.Root
		bind:ref
		bind:checked
		class={cn(
			'peer inline-flex h-[24px] w-[44px] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
			className
		)}
		{...restProps}
	>
		<SwitchPrimitive.Thumb
			class={cn(
				'pointer-events-none block size-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0'
			)}
		/>
	</SwitchPrimitive.Root>
{/if}
