<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import Button from '../primitives/button/button.svelte';
	import { use_controls, ui_text } from '../primitives/utils.js';

	let { values, on_change, empty, id, readonly, disabled, range = false, item }: {
		values: readonly T[];
		on_change(next: readonly T[]): void;
		empty: T;
		id?: string;
		readonly?: boolean;
		disabled?: boolean;
		range?: boolean;
		item: Snippet<[T, (next: T) => void, string | undefined]>;
	} = $props();
	const controls = use_controls();
	const t = ui_text();
	const locked = $derived(readonly ?? controls.readonly);
	const off = $derived(disabled ?? controls.disabled);
</script>

<div class="grid gap-2" data-time-values={range ? undefined : ''} data-time-ranges={range ? '' : undefined}>
	{#each values as value, i (i)}
		<div class="flex min-w-0 items-center gap-2">
			{@render item(
				value,
				(next) => on_change(values.map((value, index) => index === i ? next : value)),
				id ? `${id}-${i}` : undefined
			)}
			{#if !locked}<Button
					variant="ghost"
					disabled={off}
					onclick={() => on_change(values.filter((_, index) => index !== i))}>{t('remove')}</Button
				>{/if}
		</div>
	{/each}
	{#if !locked}<Button
			class="w-fit"
			variant="outline"
			disabled={off}
			onclick={() => on_change([...values, empty])}>{t('add')}</Button
		>{/if}
</div>
