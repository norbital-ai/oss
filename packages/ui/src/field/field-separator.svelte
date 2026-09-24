<script lang="ts">
	import { Imposter, Stack } from '#lib/layout';
	import { Separator } from '#lib/separator';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		children?: Snippet;
	} = $props();

	const hasContent = $derived(!!children);
</script>

<div
	bind:this={ref}
	data-slot="field-separator"
	data-content={hasContent}
	class={cn('relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2', className)}
	{...restProps}
>
	<Imposter placement="fill">
		<Stack gap="none" justify="center" fill>
			<Separator />
		</Stack>
	</Imposter>
	{#if children}
		<span
			class="relative z-20 mx-auto block w-fit bg-background px-2 text-muted-foreground"
			data-slot="field-separator-content"
		>
			{@render children()}
		</span>
	{/if}
</div>
