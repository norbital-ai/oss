<!--
@component
Several named numbers typed in one segmented field (feet and inches, a blood pressure).
-->
<script lang="ts" module>
	/** One number of a tuple: what it is called and what it accepts. */
	export type NumberTupleSegment = { readonly name: string; readonly label: string; readonly min?: number; readonly max?: number; readonly step?: number; readonly placeholder?: string };
	/** A `NumberTuple`'s value: each segment's number (or `null`) by name. */
	export type NumberTupleValue = Readonly<Record<string, number | null>>;
	/** The props of `NumberTuple`. */
	export type NumberTupleProps = {
		segments: readonly NumberTupleSegment[];
		value: NumberTupleValue;
		onChange(next: NumberTupleValue): void;
		/** Shows the numbers as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		disabled?: boolean;
		invalid?: boolean;
		size?: 'sm' | 'md';
		class?: string;
		/** The first cell's id, so a `<label for>` reaches the field. */
		id?: string;
	};
	/** Splits pasted or typed text on the delimiters a person puts between numbers. */
	export const splitNumbers = (text: string): readonly string[] =>
		text.replaceAll(/[;,·|/\t]/gu, ' ').split(/\s+/u).map((t) => t.trim()).filter((t) => t !== '' && Number.isFinite(Number(t)));
</script>

<script lang="ts">
	/**
	 * A few numbers that belong together, keyed in one motion (§3.6 Inputs): a reading, a tolerance, a coordinate. One
	 * bordered group, one cell per number with its label as a prefix; a typed `,` `;` `/` or space, or Enter, moves to the
	 * next cell, Backspace on an empty cell moves back, arrows cross the cell edges, and a pasted `62.4, 18.1, 12.9` fills
	 * every cell at once.
	 */
	import { Inline } from '../layout/index.js';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import { cn, uiText, useControls } from '../primitives/utils.js';

	let { segments, value, onChange, readonly, disabled: ownDisabled, invalid = false, size = 'md', class: className, id }: NumberTupleProps = $props();
	const controls = useControls();
	const t = uiText();
	const disabled = $derived(ownDisabled ?? controls.disabled);

	let cells: (HTMLInputElement | null)[] = $state([]);
	/** Each cell keeps its draft, so `62.` survives the keystroke between `62` and `62.4`. */
	let drafts = $state<Record<string, string>>({});
	const text = (name: string) => drafts[name] ?? (value[name] == null ? '' : String(value[name]));
	const parse = (raw: string) => { const n = raw.trim() === '' ? null : Number(raw.trim()); return n !== null && Number.isFinite(n) ? n : null; };
	function focus(index: number): void {
		cells[index]?.focus();
		cells[index]?.select();
	}
	/** Typed input, delimiter included: a keyboard that inserts text rather than sending a keydown (a phone, an IME) still walks the cells. */
	function input(index: number, raw: string): void {
		const name = segments[index]!.name;
		if (!/[;,·|/\s]/u.test(raw)) {
			drafts = { ...drafts, [name]: raw };
			return onChange({ ...value, [name]: parse(raw) });
		}
		const tokens = splitNumbers(raw);
		const next: Record<string, number | null> = { ...value }, nextDrafts = { ...drafts, [name]: '' };
		for (const [offset, token] of tokens.entries()) {
			const s = segments[index + offset];
			if (s === undefined) break;
			next[s.name] = Number(token);
			nextDrafts[s.name] = token;
		}
		drafts = nextDrafts;
		// the draft may not have changed (`62.4` then `62.4 `), so the cell is written directly
		if (cells[index]) cells[index].value = nextDrafts[name] ?? '';
		onChange(next);
		focus(Math.min(segments.length - 1, index + Math.max(1, tokens.length)));
	}
	function keydown(index: number, e: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
		const el = e.currentTarget, last = index === segments.length - 1;
		const step = e.key === 'Enter' && !last ? 1
			: e.key === 'Backspace' && el.value === '' && index > 0 ? -1
			: e.key === 'ArrowRight' && !last && el.selectionStart === el.value.length ? 1
			: e.key === 'ArrowLeft' && index > 0 && el.selectionStart === 0 ? -1 : 0;
		if (step === 0) return;
		e.preventDefault();
		focus(index + step);
	}
</script>

{#if readonly ?? controls.readonly}
	<CopyText {id} text={segments.map((s) => value[s.name] ?? '').join(', ')} class={cn('tabular-nums', className)}>
		{#each segments as segment, index (segment.name)}{index > 0 ? ' · ' : ''}<span class="text-muted-foreground">{segment.label}</span> {value[segment.name] ?? t('none')}{/each}
	</CopyText>
{:else}
<Inline gap="none" align="stretch" role="group" class={cn(
	'w-full rounded-md border border-input bg-background shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
	invalid && 'border-destructive ring-destructive/20 dark:ring-destructive/40', disabled && 'cursor-not-allowed bg-muted opacity-50 shadow-none',
	size === 'sm' ? 'h-8 text-xs' : 'h-9 text-sm', className)}>
	{#each segments as segment, index (segment.name)}
		<!-- `size=1` keeps a cell's demand at its digits, not a text input's 20-character default -->
		<label class="min-w-18 flex-1 border-input px-2 not-last:border-r">
			<Inline as="span" gap="xs" class="h-full">
				<span class="shrink-0 text-muted-foreground select-none">{segment.label}</span>
				<input bind:this={cells[index]} id={index === 0 ? id : undefined} type="text" inputmode="decimal" autocomplete="off" spellcheck="false" size={1}
					class="w-full min-w-0 flex-1 bg-transparent text-right tabular-nums outline-none placeholder:text-muted-foreground/60"
					value={text(segment.name)} placeholder={segment.placeholder ?? ''} aria-label={segment.label} aria-invalid={invalid ? 'true' : undefined} {disabled}
					oninput={(e) => input(index, e.currentTarget.value)} onkeydown={(e) => keydown(index, e)} />
			</Inline>
		</label>
	{/each}
</Inline>
{/if}
