<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';
	import { get_accordion_root, set_accordion_item } from './context.js';

	let {
		ref = $bindable(null),
		value,
		disabled = false,
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLDivElement> & {
		/** Unique key identifying this accordion section. */
		value: string;
		/** Disables toggling this section. */
		disabled?: boolean;
		/** Trigger and content of this section. */
		children?: Snippet;
	} = $props();

	const root = get_accordion_root();
	const open = $derived(root?.is_open(value) ?? false);
	const off = $derived(disabled || (root?.disabled ?? false));
	const trigger_id = $derived(`${root?.prefix ?? 'nb-acc'}-trigger-${value}`);
	const content_id = $derived(`${root?.prefix ?? 'nb-acc'}-content-${value}`);

	set_accordion_item({
		get value() {
			return value;
		},
		get open() {
			return open;
		},
		get disabled() {
			return off;
		},
		get trigger_id() {
			return trigger_id;
		},
		get content_id() {
			return content_id;
		},
		toggle: () => {
			if (!off) root?.toggle(value);
		}
	});
</script>

<div
	bind:this={ref}
	data-slot="accordion-item"
	data-state={open ? 'open' : 'closed'}
	data-disabled={off ? '' : undefined}
	class={cn('border-b last:border-b-0', className)}
	{...restProps}
>
	{@render children?.()}
</div>
