<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from '#lib/layout/layout.shared';

	export type SplitRatio = 'rail' | 'sidebar' | 'third' | 'half' | 'wide';
	export type SplitCollapse = 'stack' | 'switch' | 'none';
	export interface SplitProps extends LayoutAttributes {
		as?: LayoutElement;
		ratio?: SplitRatio;
		collapse?: SplitCollapse;
		collapseAt?: 'compact' | 'narrow';
		gap?: LayoutGap;
		/** Fill a definite-height parent so both panes can hand that height to their contents. */
		fill?: boolean;
		start: Snippet;
		end: Snippet;
		switchLabels?: readonly [string, string];
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES } from '#lib/layout/layout.shared';

	let {
		as = 'div',
		ratio = 'half',
		collapse = 'stack',
		collapseAt = 'narrow',
		gap = 'md',
		fill = false,
		start,
		end,
		switchLabels,
		class: className,
		...restProps
	}: SplitProps = $props();

	let active = $state<0 | 1>(0);
	const ratioClasses: Record<SplitRatio, string> = {
		rail: 'split--rail',
		sidebar: 'split--sidebar',
		third: 'split--third',
		half: 'split--half',
		wide: 'split--wide'
	};
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'split min-h-0 min-w-0',
		GAP_CLASSES[gap],
		ratioClasses[ratio],
		fill && 'h-full'
	)}
	data-layout="split"
	data-collapse={collapse}
	data-collapse-at={collapseAt}
	{...restProps}
>
	{#if collapse === 'switch'}
		<div class="split__switch" role="tablist" aria-label={switchLabels?.join(' or ') ?? 'Views'}>
			{#each switchLabels ?? ['First', 'Second'] as label, index}
				<button
					type="button"
					role="tab"
					aria-selected={active === index}
					class:split__switch_active={active === index}
					onclick={() => (active = index as 0 | 1)}
				>
					{label}
				</button>
			{/each}
		</div>
	{/if}
	<div class:split__pane_inactive={collapse === 'switch' && active !== 0} class="split__pane">
		{@render start()}
	</div>
	<div class:split__pane_inactive={collapse === 'switch' && active !== 1} class="split__pane">
		{@render end()}
	</div>
</svelte:element>

<style>
	.split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	}
	.split--rail {
		grid-template-columns: minmax(10rem, 14rem) minmax(0, 1fr);
	}
	.split--sidebar {
		grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
	}
	.split--third {
		grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
	}
	.split--wide {
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
	}
	.split__pane {
		min-width: 0;
		/*
			A grid item defaults to `min-height: auto`, so a pane refuses to shrink
			below its content and grows straight past a bounded `.split`. Anything
			the ancestor then clips is unreachable — no scrollbar appears, because
			the pane never overflowed anything itself. The horizontal counterpart
			above has always been here; this is the same fix for the other axis.
		*/
		min-height: 0;
	}
	.split__switch {
		display: none;
		grid-column: 1 / -1;
		width: fit-content;
		padding: 0.125rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--muted);
	}
	.split__switch button {
		padding: 0.25rem 0.75rem;
		border-radius: calc(var(--radius-md) - 2px);
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--muted-foreground);
	}
	.split__switch button.split__switch_active {
		background: var(--background);
		color: var(--foreground);
		box-shadow: var(--shadow-xs);
	}
	/*
		A Split responds to the space its caller actually grants, not to the browser window. The app
		shell, Bound, and other pane primitives establish inline-size containers, so this continues to
		work inside a sidebar, sheet, or nested dashboard pane.
	*/
	@container (max-width: 39.999rem) {
		.split[data-collapse-at='narrow']:not([data-collapse='none']) {
			grid-template-columns: minmax(0, 1fr);
		}
		.split[data-collapse-at='narrow'][data-collapse='switch'] {
			grid-template-rows: auto minmax(0, 1fr);
		}
		.split[data-collapse-at='narrow'][data-collapse='switch'] .split__switch {
			display: flex;
		}
		.split[data-collapse-at='narrow'][data-collapse='switch'] .split__pane_inactive {
			display: none;
		}
	}
	@container (max-width: 29.999rem) {
		.split[data-collapse-at='compact']:not([data-collapse='none']) {
			grid-template-columns: minmax(0, 1fr);
		}
		.split[data-collapse-at='compact'][data-collapse='switch'] {
			grid-template-rows: auto minmax(0, 1fr);
		}
		.split[data-collapse-at='compact'][data-collapse='switch'] .split__switch {
			display: flex;
		}
		.split[data-collapse-at='compact'][data-collapse='switch'] .split__pane_inactive {
			display: none;
		}
	}
</style>
