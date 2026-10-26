<!--
@component
A toolbar search trigger and popover with a bound text value or a custom indexed-search body.
-->
<script lang="ts" module>
	import type { ComponentProps, Snippet } from 'svelte';
	import type * as PopoverControls from '../../primitives/popover/index.js';

	/** The shared toolbar search popover; a custom body keeps a view's indexed search UI. */
	export type ToolbarSearchProps = {
		open?: boolean;
		value?: string;
		label: string;
		active?: boolean;
		panelClass?: string;
		onOpenAutoFocus?: ComponentProps<typeof PopoverControls.Content>['onOpenAutoFocus'];
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
		panelClass,
		onOpenAutoFocus,
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
				data-search-toggle><Glyph name="search" /></Button
			>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		align="start"
		aria-label={label}
		class={cn('flex w-[min(26rem,calc(100vw-1rem))] flex-col gap-2 p-2', panelClass)}
		data-search-panel
		onOpenAutoFocus={(event) => {
			if (onOpenAutoFocus !== undefined) onOpenAutoFocus(event);
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
					class="h-8 min-w-0 flex-1 bg-transparent text-base outline-none @xl:text-sm"
					type="search"
					placeholder={label}
					aria-label={label}
					onkeydown={(event) => {
						if (event.key === 'Enter') open = false;
					}}
					data-search
				/>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
