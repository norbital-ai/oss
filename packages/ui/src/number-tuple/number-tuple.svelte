<script lang="ts" module>
	/** One segment of a delimited-number field: what it is called and what it accepts. */
	export interface NumberTupleSegment {
		readonly name: string;
		readonly label: string;
		readonly min?: number;
		readonly max?: number;
		readonly step?: number;
		readonly placeholder?: string;
	}

	export type NumberTupleValue = Readonly<Record<string, number | null>>;

	/** Splits pasted or typed text on the delimiters a person uses between numbers. */
	export const splitNumbers = (text: string): readonly string[] =>
		text
			.replaceAll(/[;,·|/\t]/gu, ' ')
			.split(/\s+/u)
			.map((token) => token.trim())
			.filter((token) => token !== '' && Number.isFinite(Number(token)));
</script>

<script lang="ts">
	/**
	 * A delimited-number field: a few numbers that belong together, keyed in one motion.
	 *
	 * The OTP pattern for decimals — one bordered group, one cell per number with its label as a
	 * prefix, the keyboard doing the walking: `,` `;` `/` space, Tab or Enter moves to the next
	 * cell, Backspace on an empty cell moves back, arrows cross the cell edges, and a pasted
	 * `62.4, 18.1, 12.9` fills every cell at once. A reading, a tolerance, a coordinate — anything
	 * a person reads off an instrument as one line.
	 */
	import { cn } from '#lib/utils';

	let {
		segments,
		value,
		onchange,
		disabled = false,
		invalid = false,
		size = 'md',
		class: className,
		id
	}: {
		segments: readonly NumberTupleSegment[];
		value: NumberTupleValue;
		onchange: (value: NumberTupleValue) => void;
		disabled?: boolean;
		invalid?: boolean;
		size?: 'sm' | 'md';
		class?: string;
		/** The id the first cell takes, so a `<label for>` reaches the field. */
		id?: string;
	} = $props();

	let cells: Array<HTMLInputElement | null> = $state([]);
	/** Cells keep their own draft so `62.` survives the keystroke between `62` and `62.4`. */
	let drafts = $state<Record<string, string>>({});
	const text = (name: string): string => {
		const draft = drafts[name];
		if (draft !== undefined) return draft;
		const current = value[name];
		return current == null ? '' : String(current);
	};

	const parse = (raw: string): number | null => {
		const trimmed = raw.trim();
		const number = trimmed === '' ? null : Number(trimmed);
		return number !== null && Number.isFinite(number) ? number : null;
	};
	const commit = (name: string, raw: string): void => {
		drafts = { ...drafts, [name]: raw };
		onchange({ ...value, [name]: parse(raw) });
	};
	/**
	 * Typed input, delimiter included: a keyboard that inserts text rather than sending a keydown
	 * (a phone, an IME, a tool) still walks the cells — `62.4 ` moves on, `62.4 18.1` fills two.
	 */
	const onInput = (index: number, raw: string): void => {
		const name = segments[index]?.name;
		if (name === undefined) return;
		if (!/[;,·|/\s]/u.test(raw)) {
			commit(name, raw);
			return;
		}
		const tokens = splitNumbers(raw);
		const next: Record<string, number | null> = { ...value };
		const nextDrafts: Record<string, string> = { ...drafts };
		for (const [offset, token] of tokens.entries()) {
			const segment = segments[index + offset];
			if (segment === undefined) break;
			next[segment.name] = Number(token);
			nextDrafts[segment.name] = token;
		}
		if (tokens.length === 0) nextDrafts[name] = '';
		drafts = nextDrafts;
		// The draft may not have changed (`62.4` then `62.4 `), so the cell is written directly.
		const cell = cells[index];
		if (cell) cell.value = nextDrafts[name] ?? '';
		onchange(next);
		focus(Math.min(segments.length - 1, index + Math.max(1, tokens.length)));
	};
	const focus = (index: number): void => {
		const cell = cells[index];
		if (cell) {
			cell.focus();
			cell.select();
		}
	};
	/** Puts the caret in the first cell — what a form or a search box does once the field appears. */
	export const focusFirst = (): void => focus(0);
	const onKeydown = (index: number, event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
		const input = event.currentTarget;
		const last = index === segments.length - 1;
		if ([',', ';', '/', ' ', 'Enter'].includes(event.key) && !last) {
			event.preventDefault();
			focus(index + 1);
			return;
		}
		if (event.key === 'Backspace' && input.value === '' && index > 0) {
			event.preventDefault();
			focus(index - 1);
			return;
		}
		if (event.key === 'ArrowRight' && !last && input.selectionStart === input.value.length) {
			event.preventDefault();
			focus(index + 1);
			return;
		}
		if (event.key === 'ArrowLeft' && index > 0 && input.selectionStart === 0) {
			event.preventDefault();
			focus(index - 1);
		}
	};
	const onPaste = (index: number, event: ClipboardEvent) => {
		const pasted = splitNumbers(event.clipboardData?.getData('text') ?? '');
		if (pasted.length < 2) return;
		event.preventDefault();
		const next: Record<string, number | null> = { ...value };
		const nextDrafts: Record<string, string> = { ...drafts };
		for (const [offset, token] of pasted.entries()) {
			const segment = segments[index + offset];
			if (segment === undefined) break;
			next[segment.name] = Number(token);
			nextDrafts[segment.name] = token;
		}
		drafts = nextDrafts;
		onchange(next);
		focus(Math.min(segments.length - 1, index + pasted.length));
	};
	const sizes = { sm: 'h-8 text-xs', md: 'h-9 text-sm' };
</script>

<div
	class={cn(
		'flex w-full items-stretch divide-x divide-input rounded-md border border-input bg-background shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
		invalid && 'border-destructive ring-destructive/20 dark:ring-destructive/40',
		disabled && 'cursor-not-allowed opacity-50 shadow-none',
		sizes[size],
		className
	)}
	role="group"
>
	{#each segments as segment, index (segment.name)}
		<!-- `size=1` keeps a cell's demand at its digits, not a text input's 20-character default,
		     so three cells never squeeze each other's input to nothing; the floor keeps room for one. -->
		<label class="flex min-w-[4.5rem] flex-1 items-center gap-1 px-2">
			<span class="shrink-0 text-muted-foreground select-none">{segment.label}</span>
			<input
				bind:this={cells[index]}
				id={index === 0 ? id : undefined}
				type="text"
				inputmode="decimal"
				autocomplete="off"
				spellcheck="false"
				size={1}
				class="w-full min-w-0 flex-1 bg-transparent text-right tabular-nums outline-none placeholder:text-muted-foreground/60"
				value={text(segment.name)}
				placeholder={segment.placeholder ?? ''}
				aria-label={segment.label}
				{disabled}
				min={segment.min}
				max={segment.max}
				step={segment.step}
				oninput={(event) => onInput(index, event.currentTarget.value)}
				onkeydown={(event) => onKeydown(index, event)}
				onpaste={(event) => onPaste(index, event)}
			/>
		</label>
	{/each}
</div>
