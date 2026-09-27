<script lang="ts">
	// `text many`: each entry a chip; Enter or a comma adds, Backspace on an empty box removes the last.
	import Icon from '@iconify/svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import { CONTROL } from './classes.js';

	let { value, onChange, id, disabled = false, invalid = false }: {
		value: readonly string[]; onChange(next: readonly string[]): void; id?: string; disabled?: boolean; invalid?: boolean;
	} = $props();
	const t = uiText();
	let text = $state('');
	function commit() {
		const add = text.split(',').map((s) => s.trim()).filter((s) => s !== '' && !value.includes(s));
		text = '';
		if (add.length > 0) onChange([...value, ...add]);
	}
</script>

<div class={cn(CONTROL, 'flex h-auto min-h-9 flex-wrap items-center gap-1 py-1')} aria-invalid={invalid ? 'true' : undefined}>
	{#each value as item (item)}
		<span class="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs">
			{item}
			{#if !disabled}
				<button type="button" aria-label={`${t('remove')} ${item}`} onclick={() => onChange(value.filter((x) => x !== item))}><Icon icon="lucide:x" class="size-3" /></button>
			{/if}
		</span>
	{/each}
	<input
		{id}
		class="min-w-24 flex-1 bg-transparent text-sm outline-none"
		value={text}
		{disabled}
		oninput={(e) => { text = e.currentTarget.value; if (text.includes(',')) commit(); }}
		onkeydown={(e) => {
			if (e.key === 'Enter') { e.preventDefault(); commit(); }
			else if (e.key === 'Backspace' && text === '' && value.length > 0) onChange(value.slice(0, -1));
		}}
		onblur={commit}
	/>
</div>
