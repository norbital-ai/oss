<script lang="ts">
	// A kind typed as text (int, number, decimal, duration, text): the value changes only when the text parses, so a
	// half-typed "1." never reaches the draft as a wrong number, and a parse problem shows under the box.
	import Input from '../primitives/input/input.svelte';
	import { format, parse, untag, type Json, type Kind } from './kind.js';

	let { kind, value, onChange, id, disabled = false, invalid = false, placeholder }: {
		kind: Kind; value: Json; onChange(next: Json): void; id?: string; disabled?: boolean; invalid?: boolean; placeholder?: string;
	} = $props();

	const shown = (v: Json) => (kind.kind === 'duration' ? format(kind, v) : v === null ? '' : String(untag(v)));
	let text = $state('');
	let problem = $state<string | null>(null);
	let last: Json | undefined;
	$effect.pre(() => {
		// an outside change (reset, refusal, another field's transform echo) replaces the text; our own echo does not
		if (value !== last) { text = shown(value); problem = null; last = value; }
	});
	const numeric = $derived(['int', 'number', 'decimal', 'money'].includes(kind.kind));
	function input(next: string) {
		text = next;
		const p = parse(kind, next);
		problem = 'error' in p ? p.error : null;
		if ('value' in p) { last = p.value; onChange(p.value); }
	}
</script>

<Input
	{id}
	value={text}
	oninput={(e) => input(e.currentTarget.value)}
	inputmode={kind.kind === 'int' ? 'numeric' : numeric ? 'decimal' : undefined}
	type={kind.kind === 'text' && kind.format === 'email' ? 'email' : kind.kind === 'text' && kind.format === 'url' ? 'url' : kind.kind === 'text' && kind.format === 'phone' ? 'tel' : 'text'}
	maxlength={kind.kind === 'text' ? kind.max : undefined}
	class={numeric ? 'tabular-nums' : undefined}
	aria-invalid={invalid || problem !== null ? 'true' : undefined}
	{disabled}
	{placeholder}
/>
{#if problem}<p class="text-xs text-destructive">{problem}</p>{/if}
