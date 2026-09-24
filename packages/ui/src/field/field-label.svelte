<script lang="ts">
	import { Label } from '#lib/label';
	import { cn } from '#lib/utils';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: ComponentProps<typeof Label> = $props();
</script>

<Label
	bind:ref
	data-slot="field-label"
	class={cn(
		// repository-health:allow UI6 -- the bits-ui label element's children must stay direct: `has-[>[data-slot=field]]` and `[&>*]:data-[slot=field]` select them, so a nested primitive would break the choice-card styling
		// repository-health:allow UI27 -- the gap of the same bits-ui label element (see UI6 above)
		'group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50',
		'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border [&>*]:data-[slot=field]:p-4',
		'has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 dark:has-data-[state=checked]:bg-primary/10',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</Label>
