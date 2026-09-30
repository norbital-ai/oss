<!--
@component
The kit's select: a field-like trigger and a searchable option list in a popover, filtered locally or through `onSearch`.
-->
<script lang="ts" module>
	/** One choice: `label` is shown and searched (with `keywords`); `group` heads a section. */
	export type ComboboxOption<V extends string = string> = {
		value: V;
		label: string;
		description?: string;
		icon?: string;
		group?: string;
		keywords?: string;
	};
	/**
	 * The kit's only select (no native `<select>` anywhere): a trigger that reads like a field and a searchable list in
	 * a popover. Filters locally, or hands each keystroke to `onSearch` (the caller replaces `options`, as `Picker` does).
	 */
	export type ComboboxProps<V extends string = string> = {
		options: readonly ComboboxOption<V>[];
		value: V | null;
		onChange(next: V | null): void;
		/** Offer a "none" row that clears the value. */
		clearable?: boolean;
		placeholder?: string;
		/** The trigger's text when `value` is not among `options` (a picker's chosen row on another page). */
		display?: string;
		/** Show the search box; default when there are more than 8 options or `onSearch` is given. */
		searchable?: boolean;
		onSearch?(query: string): void;
		onOpenChange?(open: boolean): void;
		loading?: boolean;
		failed?: boolean;
		size?: 'sm' | 'default';
		/** `ghost`: no border, fill or shadow, small text; for a combobox in chrome or a toolbar, not a form. */
		variant?: 'default' | 'ghost';
		id?: string;
		/** Shows the chosen label as copyable text, no trigger; an enclosing readonly form sets it. */
		readonly?: boolean;
		/** The trigger stays, muted and inert; an enclosing disabled form sets it. */
		disabled?: boolean;
		invalid?: boolean;
		class?: string;
		'aria-label'?: string;
	};
</script>

<script lang="ts" generics="V extends string = string">
	import Icon from '@iconify/svelte';
	import { tick } from 'svelte';
	import { CONTROL } from '../../kinds/classes.js';
	import CopyText from '../copy-text/copy-text.svelte';
	import * as Popover from '../popover/index.js';
	import { claimFieldControl, cn, uiText, useControls } from '../utils.js';
	import { virtualList } from '../virtual/virtual.svelte.js';

	const GHOST = 'h-7 min-w-0 rounded-md bg-transparent px-1.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:text-destructive';

	let {
		options, value, onChange, clearable = false, placeholder, display, searchable, onSearch, onOpenChange, loading = false, failed = false,
		size = 'default', variant = 'default', id: ownId, readonly: ownReadonly, disabled: ownDisabled, invalid = false, class: className, 'aria-label': ariaLabel
	}: ComboboxProps<V> = $props();
	// svelte-ignore state_referenced_locally -- the id is fixed at mount
	const id = ownId ?? claimFieldControl();
	const t = uiText();
	const controls = useControls();
	const readonly = $derived(ownReadonly ?? controls.readonly);
	const disabled = $derived(ownDisabled ?? controls.disabled);
	let open = $state(false), query = $state(''), active = $state(0);
	let list = $state<HTMLElement | null>(null), search = $state<HTMLInputElement | null>(null);
	const current = $derived(options.find((o) => o.value === value));
	const withSearch = $derived(searchable ?? (onSearch !== undefined || options.length > 8));
	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (onSearch !== undefined || q === '') return options;
		return options.filter((o) => `${o.label} ${o.keywords ?? ''} ${o.value}`.toLowerCase().includes(q));
	});
	// the "none" row is row 0 when offered
	const rows = $derived<readonly (ComboboxOption<V> | null)[]>(clearable && value !== null ? [null, ...shown] : shown);
	// a group heading is its own list entry, so a long list (every time zone) windows over measured entries
	const entries = $derived(rows.flatMap((row, i): ({ head: string; i: number } | { i: number })[] =>
		row?.group !== undefined && row.group !== rows[i - 1]?.group ? [{ head: row.group, i }, { i }] : [{ i }]));
	const entryOf = $derived(new Map(entries.flatMap((e, k) => 'head' in e ? [] : [[e.i, k] as const])));
	const entryKey = (k: number) => { const e = entries[k]!; return 'head' in e ? `head:${e.i}` : `row:${rows[e.i]?.value ?? '\u0000none'}`; };
	const win = virtualList({ count: () => entries.length, key: entryKey, estimate: 32, threshold: 100 });
	/** Brings row `i` into view: by the window's offsets when windowed (it may not be mounted yet). */
	const reveal = (i: number) => win.on ? win.reveal(entryOf.get(i) ?? 0) : list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });

	async function toggle(next: boolean) {
		open = next;
		onOpenChange?.(next);
		if (!next) return;
		query = '';
		onSearch?.('');
		active = Math.max(0, rows.findIndex((r) => r?.value === value));
		await tick();
		(search ?? list)?.focus();
		reveal(active);
	}
	function choose(row: ComboboxOption<V> | null) {
		onChange(row?.value ?? null);
		void toggle(false);
	}
	function keydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			active = rows.length === 0 ? 0 : (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
			void tick().then(() => reveal(active));
		} else if (e.key === 'Enter' && rows[active] !== undefined) {
			e.preventDefault();
			choose(rows[active]!);
		}
	}
</script>

{#if readonly}
	{@const label = current?.label ?? display ?? (value === null ? '' : value)}
	<CopyText {id} text={label}>
		{#if label === ''}<span class="text-muted-foreground">{t('none')}</span>{:else}{label}{/if}
	</CopyText>
{:else}
<Popover.Root {open} onOpenChange={toggle}>
	<Popover.Trigger
		{id}
		{disabled}
		role="combobox"
		aria-expanded={open}
		aria-label={ariaLabel}
		aria-invalid={invalid ? 'true' : undefined}
		class={cn(variant === 'ghost' ? GHOST : cn(CONTROL, size === 'sm' && 'h-8 px-2'), 'flex items-center justify-between gap-2 text-left font-normal', className)}
	>
		<span class={cn('flex min-w-0 items-center gap-2', current === undefined && display === undefined && 'text-muted-foreground')}>
			{#if current?.icon}<Icon icon={current.icon} class="size-4 shrink-0 text-muted-foreground" />{/if}
			<span class="truncate">{current?.label ?? display ?? placeholder ?? t('select')}</span>
		</span>
		<Icon icon="lucide:chevrons-up-down" class={cn('shrink-0 text-muted-foreground', variant === 'ghost' ? 'size-3' : 'size-3.5')} />
	</Popover.Trigger>
	<Popover.Content align="start" sameWidth minWidth={variant === 'ghost' ? 256 : 192} class="gap-1 p-1" onkeydown={keydown}>
		{#if withSearch}
			<input
				bind:this={search}
				class="h-8 w-full rounded-sm border-b bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
				placeholder={t('search')}
				value={query}
				oninput={(e) => { query = e.currentTarget.value; active = 0; onSearch?.(query); }}
			/>
		{/if}
		<ul bind:this={list} class="max-h-64 overflow-auto outline-none" role="listbox" tabindex="-1">
			{#if win.on}<li role="presentation" style="height:{win.before}px" {@attach win.anchor}></li>{/if}
			{#each win.slice(entries) as e, j (entryKey(win.start + j))}
				{@const i = e.i}
				{@const row = rows[i]!}
				{@const selected = row === null ? false : row.value === value}
				{#if 'head' in e}
					<li role="presentation" class="px-2 pt-2 pb-1 text-overline text-muted-foreground" {@attach win.measure(entryKey(win.start + j))}>{e.head}</li>
				{:else}
				<li role="option" aria-selected={selected} data-index={i} data-value={row?.value ?? ''} {@attach win.measure(entryKey(win.start + j))}>
					<button
						type="button"
						tabindex="-1"
						class={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm', i === active && 'bg-accent text-accent-foreground')}
						onmousemove={() => (active = i)}
						onclick={() => choose(row)}
					>
						{#if row === null}
							<span class="flex-1 text-muted-foreground">{t('none')}</span>
						{:else}
							{#if row.icon}<Icon icon={row.icon} class="size-4 shrink-0 text-muted-foreground" />{/if}
							<span class="min-w-0 flex-1">
								<span class="block truncate">{row.label}</span>
								{#if row.description}<span class="block truncate text-xs text-muted-foreground">{row.description}</span>{/if}
							</span>
							{#if selected}<Icon icon="lucide:check" class="size-3.5 shrink-0" />{/if}
						{/if}
					</button>
				</li>
				{/if}
			{:else}
				<li class="p-2 text-xs text-muted-foreground">{loading ? t('search') : failed ? t('optionsUnavailable') : t('noResults')}</li>
			{/each}
			{#if win.after > 0}<li role="presentation" style="height:{win.after}px"></li>{/if}
		</ul>
	</Popover.Content>
</Popover.Root>
{/if}
