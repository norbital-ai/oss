<!--
@component
A toolbar search trigger and popover with a bound text value or a custom indexed-search body.
@example
<ToolbarSearch label="Search people" bind:value={q} />
-->
<script lang="ts" module>
	import type { ComponentProps, Snippet } from 'svelte';
	import type * as PopoverControls from '../../primitives/popover/index.js';

	/** The shared toolbar search popover; a custom body keeps a view's indexed search UI. */
	type ToolbarSearchProps = {
		/** Whether the popover is open (bindable). Enter or Escape in the default input closes it. */
		open?: boolean;
		/** The search text (bindable), edited by the default input. */
		value?: string;
		/** The trigger's hint and accessible name, and the input's placeholder. */
		label: string;
		/** Highlights the trigger as searching. Default: `value` is not empty. */
		active?: boolean;
		/** Extra classes on the popover panel. */
		panel_class?: string;
		/** Replaces the default focus of the input when the popover opens. */
		on_open_auto_focus?: ComponentProps<typeof PopoverControls.Content>['on_open_auto_focus'];
		/** A custom body in place of the default input. */
		children?: Snippet;
	};
</script>

<script lang="ts">
	import Button from '../../primitives/button/button.svelte';
	import Glyph from '../../primitives/icon/Glyph.svelte';
	import * as Popover from '../../primitives/popover/index.js';
	import { cn } from '../../primitives/utils.js';

	let {
		open = $bindable(false),
		value = $bindable(''),
		label,
		active,
		panel_class,
		on_open_auto_focus,
		children
	}: ToolbarSearchProps = $props();
	let box = $state<HTMLInputElement>();
	const searching = $derived(active ?? value !== '');
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				size="icon"
				variant="ghost"
				class={searching ? 'bg-accent' : ''}
				hint={label}
				aria-label={label}
				data-search-toggle><Glyph name="search" class="size-3.5" /></Button
			>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		align="start"
		aria-label={label}
		class={cn('flex w-[min(26rem,calc(100vw-1rem))] flex-col gap-2 p-2', panel_class)}
		data-search-panel
		on_open_auto_focus={(event) => {
			if (on_open_auto_focus !== undefined) on_open_auto_focus(event);
			else {
				event.preventDefault();
				box?.focus();
			}
		}}
	>
		{#if children}
			{@render children()}
		{:else}
			<div
				class="border-input bg-background focus-within:ring-ring/50 flex min-h-8 flex-wrap items-center gap-1 rounded-sm border px-2 shadow-xs focus-within:ring-[3px]"
			>
				<Glyph name="search" class="text-muted-foreground size-4 shrink-0" />
				<input
					bind:this={box}
					bind:value
					class="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
					type="search"
					placeholder={label}
					aria-label={label}
					onkeydown={(event) => {
						if (event.key === 'Enter') open = false;
						if (event.key === 'Escape') {
							// the search is the topmost layer: its Escape must not close the dialog or sheet beneath it
							event.preventDefault();
							event.stopPropagation();
							open = false;
						}
					}}
					data-search
				/>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
