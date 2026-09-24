<script lang="ts">
	import { Inline } from '#lib/layout';
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
			'inline-block h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors',
			// Apply colors based on the `checked` state
			checked ? 'bg-primary' : 'bg-input',
			// If disabled while readonly, apply opacity
			restProps.disabled && 'opacity-50',
			className
		)}
		aria-readonly="true"
	>
		<Inline gap="none" fill>
			<div
				class={cn(
					'block size-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
					// Translate the thumb based on the `checked` state
					checked ? 'translate-x-5' : 'translate-x-0'
				)}
			></div>
		</Inline>
	</div>
{:else}
	<SwitchPrimitive.Root
		bind:ref
		bind:checked
		class={cn(
			'peer inline-block h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
			className
		)}
		{...restProps}
	>
		<Inline as="span" gap="none" fill>
			<SwitchPrimitive.Thumb
				class="pointer-events-none block size-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
			/>
		</Inline>
	</SwitchPrimitive.Root>
{/if}
