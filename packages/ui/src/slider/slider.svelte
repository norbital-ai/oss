<script lang="ts">
	import { Bound, Imposter, Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { Slider as SliderPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		value = $bindable(),
		orientation = 'horizontal',
		class: className,
		...restProps
	}: WithoutChildrenOrChild<SliderPrimitive.RootProps> = $props();

	const Track = $derived(orientation === 'vertical' ? Stack : Inline);
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
	bind:ref
	bind:value={value as never}
	{orientation}
	class={cn(
		"relative touch-none select-none data-[orientation='horizontal']:w-full data-[orientation='vertical']:h-full data-[orientation='vertical']:min-h-44 data-[orientation='vertical']:w-auto",
		className
	)}
	{...restProps}
>
	{#snippet child({ props, thumbs })}
		<Track as="span" gap="none" align="center" {...props}>
			<!-- The rounded track clips bits-ui's range, which it places by start/end offsets in its own style. -->
			<Bound
				as="span"
				size="auto"
				clip
				grow
				data-orientation={orientation}
				class="relative rounded-full bg-secondary data-[orientation='horizontal']:h-2 data-[orientation='horizontal']:w-full data-[orientation='vertical']:h-full data-[orientation='vertical']:w-2"
			>
				<SliderPrimitive.Range
					class="bg-primary data-[orientation='horizontal']:h-full data-[orientation='vertical']:w-full"
				>
					{#snippet child({ props })}
						<Imposter as="span" placement="top-start" offset="none" layer="under" {...props} />
					{/snippet}
				</SliderPrimitive.Range>
			</Bound>
			{#each thumbs as thumb (thumb)}
				<SliderPrimitive.Thumb
					index={thumb}
					class="block size-5 rounded-full border-2 border-primary bg-background transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50"
				/>
			{/each}
		</Track>
	{/snippet}
</SliderPrimitive.Root>
