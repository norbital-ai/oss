<!--
@component
A toolbar filter trigger with an active-condition count and a popover for custom filter controls.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';

	/** The shared toolbar filter trigger and popover, independent of a collection or tenant. */
	export type ToolbarFilterProps = {
		open?: boolean;
		count?: number;
		label?: string;
		panelClass?: string;
		onOpenChange?: (open: boolean) => void;
		children: Snippet;
	};
</script>

<script lang="ts">
	import * as Popover from '../../primitives/popover/index.js';
	import { cn } from '../../primitives/utils.js';

	let {
		open = $bindable(false),
		count = 0,
		label = 'Filter and sort',
		panelClass,
		onOpenChange,
		children
	}: ToolbarFilterProps = $props();
</script>

<Popover.Root bind:open onOpenChange={(value) => onOpenChange?.(value)}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class={cn(
					'hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring relative inline-flex h-9 min-w-9 max-sm:h-11 max-sm:min-w-11 items-center justify-center gap-1 rounded-sm px-2 focus-visible:ring-2 focus-visible:outline-none',
					count > 0 && 'bg-accent'
				)}
				aria-label={label}
				title={label}
				data-view-popover
				data-view-trigger
			>
				<svg
					viewBox="0 0 24 24"
					class="size-4"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					aria-hidden="true"
					data-icon="sliders"
				>
					<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
				</svg>
				{#if count > 0}<span
						class="bg-primary text-primary-foreground rounded-full px-1.5 text-xs leading-5"
						data-view-count>{count}</span
					>{/if}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		align="start"
		aria-label={label}
		class={cn(
			'flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 p-3',
			'[&_input:not([type=checkbox])]:min-h-(--hit-target) [&_select]:min-h-(--hit-target)',
			panelClass
		)}
		data-view-panel
	>
		{@render children()}
	</Popover.Content>
</Popover.Root>
