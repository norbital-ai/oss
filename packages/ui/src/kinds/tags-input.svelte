<script lang="ts">
	// `text many`: each entry a chip; Enter or a comma adds, Backspace on an empty box removes the last,
	// ArrowLeft/Right navigates chips, double-click/Enter edits a chip in place.
	import Icon from '@iconify/svelte';
	import { untrack } from 'svelte';
	import { create_token_input } from '../behaviors/index.js';
	import { cn, ui_text } from '../primitives/utils.js';
	import { CONTROL } from './classes.js';

	let {
		value,
		on_change,
		id,
		disabled = false,
		invalid = false
	}: {
		value: readonly string[];
		on_change(next: readonly string[]): void;
		id?: string;
		disabled?: boolean;
		invalid?: boolean;
	} = $props();
	const t = ui_text();
	const controlId = untrack(() => id);
	const tokens = create_token_input({
		value: () => value,
		on_change: (next) => on_change(next),
		disabled: () => disabled,
		...(controlId !== undefined ? { control: { id: `tags:${controlId}` } } : {})
	});
</script>

<div
	class={cn(CONTROL, 'flex h-auto min-h-8 flex-wrap items-center gap-1 py-1')}
	aria-invalid={invalid ? 'true' : undefined}
>
	{#each tokens.values as item, i (item)}
		{#if tokens.editing_index === i}
			<input
				class="w-24 rounded-sm bg-muted px-1.5 py-0.5 text-xs outline-none ring-1 ring-ring"
				value={tokens.editing_text}
				oninput={(e) => (tokens.editing_text = e.currentTarget.value)}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						tokens.commit_edit();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						tokens.cancel_edit();
					}
				}}
				onblur={() => tokens.commit_edit()}
			/>
		{:else}
			<span
				class="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
				{@attach tokens.chip(i)}
				{...tokens.chip_attrs(i)}
			>
				{item}
				{#if !disabled}
					<button
						type="button"
						tabindex="-1"
						aria-label={`${t('remove')} ${item}`}
						onclick={() => tokens.remove_at(i)}
						><Icon icon="lucide:x" class="size-3" /></button
					>
				{/if}
			</span>
		{/if}
	{/each}
	<input
		{id}
		class="min-w-24 flex-1 bg-transparent text-sm outline-none"
		{@attach tokens.input}
		{...tokens.input_attrs()}
	/>
</div>
