<script lang="ts">
	import { untrack } from 'svelte';
	import { create_resize } from '../behaviors/index.js';

	let {
		width,
		label,
		last = false,
		on_change,
		on_commit
	}: {
		width: number;
		label: string;
		last?: boolean;
		on_change: (next: number) => void;
		on_commit: () => void;
	} = $props();

	let handleEl = $state<HTMLSpanElement | null>(null);
	const resize = create_resize({
		value: () => handleEl?.parentElement?.offsetWidth ?? width,
		on_change: (next) => on_change(next),
		on_commit: () => on_commit(),
		axis: 'horizontal',
		min: 64,
		step: 16,
		label: untrack(() => label)
	});
	const attrs = $derived(resize.handle_attrs());
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<span
	bind:this={handleEl}
	{...attrs}
	aria-label={label}
	data-column-resize
	class={[
		'group/resize absolute inset-y-0 z-10 flex w-2 cursor-col-resize touch-none justify-center select-none outline-none focus-visible:ring-2 focus-visible:ring-ring',
		last ? 'right-0' : '-right-1'
	]}
	onpointerdown={(event) => {
		event.stopPropagation();
		attrs.onpointerdown(event);
	}}
>
	<span
		class="bg-muted-foreground/40 group-hover/resize:bg-brand my-auto h-5 w-px opacity-0 transition-opacity group-hover:opacity-100 group-hover/resize:w-0.5"
	></span>
</span>
