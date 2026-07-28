<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';

	type InputType = Exclude<HTMLInputTypeAttribute, 'file'>;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, 'type'> &
			({ type: 'file'; files?: FileList } | { type?: InputType; files?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		class: className,
		'data-slot': dataSlot = 'input',
		...restProps
	}: Props = $props();

	// Special classes to hide spinners on number inputs for a cleaner look
	const numberInputClasses =
		'[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]';
</script>

{#if type === 'file'}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'flex h-9 w-full min-w-0 rounded-sm border border-input bg-background px-3 pt-1.5 text-sm font-medium shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
			'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
			'aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:ring-inset dark:aria-invalid:ring-destructive/40',
			'disabled:bg-muted disabled:shadow-none',
			className
		)}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'flex h-9 w-full min-w-0 rounded-sm border border-input bg-background px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
			'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
			'aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:ring-inset dark:aria-invalid:ring-destructive/40',
			'disabled:bg-muted disabled:shadow-none',
			type === 'number' && numberInputClasses,
			className
		)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
