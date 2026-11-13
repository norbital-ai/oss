<!--
@component
The kit's select: a field-like trigger and a searchable option list in a popover, filtered locally or through `on_search`.
@example
<Combobox options={[{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }]} {value} on_change={(v) => (value = v)} />
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';

	/** One choice: `label` is shown and searched (with `keywords`); `group` heads a section. */
	export type ComboboxOption<V extends string = string> = {
		value: V;
		label: string;
		/** Fixed trailing information, kept visible while a long label truncates (e.g. an available balance). */
		suffix?: string;
		description?: string;
		icon?: string;
		group?: string;
		keywords?: string;
	};
	/**
	 * The kit's only select (no native `<select>` anywhere): a trigger that reads like a field and a searchable list in
	 * a popover. Filters locally, or hands each keystroke to `on_search` (the caller replaces `options`, as `Picker` does).
	 */
	type ComboboxCommonProps<V extends string = string> = {
		/** The choices, in order; with `on_search` the caller replaces them per query. */
		options: readonly ComboboxOption<V>[];
		/** Offer a "none" row that clears the value. */
		clearable?: boolean;
		/** The trigger's text with nothing chosen, and its accessible name without `aria-label`. */
		placeholder?: string;
		/** The trigger's text when `value` is not among `options` (a picker's chosen row on another page). */
		display?: string;
		/** Show the search box; default when there are more than 8 options or `on_search` is given. */
		searchable?: boolean;
		/** Each keystroke's query (and `''` on open) instead of local filtering; the caller supplies matching `options`. */
		on_search?(query: string): void;
		/** Called as the list opens or closes. */
		on_open_change?(open: boolean): void;
		/** The list shows the loading message in place of options. */
		loading?: boolean;
		/** The list shows the failure message in place of options. */
		failed?: boolean;
		/** `ghost`: no border, fill or shadow; for a combobox in chrome or a toolbar, not a form. Same size either way. */
		variant?: 'default' | 'ghost';
		/** The trigger's id, for a `<label for>`; an enclosing `Field` supplies one. */
		id?: string;
		/** Shows the chosen label as copyable text, no trigger; an enclosing readonly form sets it. */
		readonly?: boolean;
		/** The trigger stays, muted and inert; an enclosing disabled form sets it. */
		disabled?: boolean;
		/** Marks the trigger `aria-invalid` (error styling). */
		invalid?: boolean;
		/** Classes on the trigger. */
		class?: string;
		/** The trigger's accessible name; the chosen labels are appended. */
		'aria-label'?: string;
		/** Rendered between the search box and the list (tabs that scope `options`, with `on_search`). */
		header?: Snippet;
		/** Rendered below the scrollable option list. */
		footer?: Snippet;
		/** Rendered inside the trigger, before its chevron: a status the chosen value carries. */
		badge?: Snippet;
		/** The trigger's content, in place of the value and chevron (a workspace chip with its avatar). */
		trigger?: Snippet<[ComboboxOption<V> | null]>;
		/** A row's leading content, in place of `icon` (an avatar); its label, suffix and check still follow. */
		lead?: Snippet<[ComboboxOption<V>]>;
		/** A caller's empty state; loading and failed states keep the standard messages. */
		empty?: Snippet;
		/** Handle scope shortcuts before list navigation; preventing default resets the active option. */
		onkeydown?(event: KeyboardEvent): void;
	};
	/** A searchable choice field; `multiple: true` toggles an array of choices while keeping the list open. */
	export type ComboboxProps<
		V extends string = string,
		M extends boolean = false
	> = ComboboxCommonProps<V> & {
		/** `true`: `value` is an array and each pick toggles one choice, the list staying open. */
		multiple?: M;
	} & {
		/** The chosen value (`null` for none), or the chosen values when `multiple`. */
		value: M extends true ? readonly V[] : V | null;
		/** Called with the next value (or values) on each pick or clear. */
		on_change(next: M extends true ? readonly V[] : V | null): void;
	};
</script>

<script lang="ts" generics="V extends string = string, M extends boolean = false">
	import Icon from '@iconify/svelte';
	import { tick } from 'svelte';
	import { CONTROL_ICON, CONTROL_SIZE, SELECT_TRIGGER } from '../../kinds/classes.js';
	import CopyText from '../copy-text/copy-text.svelte';
	import * as Popover from '../popover/index.js';
	import {
		claimFieldControl,
		cn,
		coarsePointer,
		stepActive,
		ui_text,
		use_controls
	} from '../utils.js';
	import { virtual_list } from '../virtual/virtual.svelte.js';

	const GHOST = `${CONTROL_SIZE} flex items-center justify-between rounded-md bg-transparent text-left font-normal outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:text-destructive`;

	const props: ComboboxProps<V, M> = $props();
	function isMultiple(p: ComboboxProps<V, M>): p is ComboboxProps<V, M> & ComboboxProps<V, true> {
		return p.multiple === true;
	}
	function isSingle(p: ComboboxProps<V, M>): p is ComboboxProps<V, M> & ComboboxProps<V, false> {
		return p.multiple !== true;
	}
	let {
		options,
		value,
		clearable = false,
		placeholder,
		display,
		searchable,
		on_search,
		on_open_change,
		loading = false,
		failed = false,
		variant = 'default',
		id: ownId,
		readonly: ownReadonly,
		disabled: ownDisabled,
		invalid = false,
		class: className,
		'aria-label': ariaLabel,
		header,
		footer,
		badge,
		trigger,
		lead,
		empty
	} = $derived(props);
	// svelte-ignore state_referenced_locally -- the id is fixed at mount
	const id = ownId ?? claimFieldControl();
	const t = ui_text();
	const controls = use_controls();
	const readonly = $derived(ownReadonly ?? controls.readonly);
	const disabled = $derived(ownDisabled ?? controls.disabled);
	let open = $state(false),
		query = $state(''),
		active = $state(0);
	let list = $state<HTMLElement | null>(null),
		search = $state<HTMLInputElement | null>(null);
	const current = $derived(options.find((o) => o.value === value));
	const selectedValues = $derived(isMultiple(props) ? props.value : []);
	const selectedLabels = $derived(
		selectedValues.map((v) => options.find((o) => o.value === v)?.label ?? v)
	);
	const selectionText = $derived(selectedLabels.join(', '));
	const multiLabel = $derived(
		selectedLabels.length <= 2
			? selectionText
			: t('selectedCount').replace('{n}', String(selectedLabels.length))
	);
	const withSearch = $derived(searchable ?? (on_search !== undefined || options.length > 8));
	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (on_search !== undefined || q === '') return options;
		return options.filter((o) =>
			`${o.label} ${o.keywords ?? ''} ${o.value}`.toLowerCase().includes(q)
		);
	});
	// the "none" row is row 0 when offered
	const rows = $derived<readonly (ComboboxOption<V> | null)[]>(
		clearable && (isMultiple(props) ? props.value.length > 0 : value !== null)
			? [null, ...shown]
			: shown
	);
	// a group heading is its own list entry, so a long list (every time zone) windows over measured entries
	const entries = $derived(
		rows.flatMap((row, i): ({ head: string; i: number } | { row: ComboboxOption<V> | null; i: number })[] =>
			row?.group !== undefined && row.group !== rows[i - 1]?.group
				? [{ head: row.group, i }, { row, i }]
				: [{ row, i }]
		)
	);
	const entryOf = $derived(
		new Map(entries.flatMap((e, k) => ('head' in e ? [] : [[e.i, k] as const])))
	);
	const entryKey = (k: number) => {
		const e = entries[k];
		if (e === undefined) throw new RangeError('The combobox entry is outside its list.');
		return 'head' in e ? `head:${e.i}` : `row:${e.row?.value ?? '\u0000none'}`;
	};
	const win = virtual_list({
		count: () => entries.length,
		key: entryKey,
		estimate: 32,
		threshold: 100
	});
	/** Brings row `i` into view: by the window's offsets when windowed (it may not be mounted yet). */
	const reveal = (i: number) =>
		win.on
			? win.reveal(entryOf.get(i) ?? 0)
			: list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });

	async function toggle(next: boolean) {
		open = next;
		on_open_change?.(next);
		if (!next) return;
		query = '';
		on_search?.('');
		active = Math.max(
			0,
			rows.findIndex(
				(r) =>
					r !== null &&
					(isMultiple(props) ? props.value.includes(r.value) : r.value === props.value)
			)
		);
		await tick();
		// a focused search raises the on-screen keyboard over the short list: touch taps the box to type
		(coarsePointer.current ? list : (search ?? list))?.focus();
		reveal(active);
	}
	function choose(row: ComboboxOption<V> | null) {
		if (isMultiple(props)) {
			props.on_change(
				row === null
					? []
					: props.value.includes(row.value)
						? props.value.filter((v) => v !== row.value)
						: [...props.value, row.value]
			);
		} else if (isSingle(props)) {
			props.on_change(row?.value ?? null);
			void toggle(false);
		}
	}
	function keydown(e: KeyboardEvent) {
		props.onkeydown?.(e);
		if (e.defaultPrevented) {
			active = 0;
			return;
		}
		// Header and footer controls keep their native keyboard activation.
		if (
			e.target !== search &&
			e.target !== list &&
			!(e.target instanceof Element && e.target.closest('[role="option"]'))
		)
			return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			active = stepActive(rows.length, active, e.key === 'ArrowDown' ? 1 : -1);
			void tick().then(() => reveal(active));
		} else if (e.key === 'Enter') {
			const row = rows[active];
			if (row !== undefined) {
				e.preventDefault();
				choose(row);
			}
		}
	}
</script>

{#if readonly}
	{@const label = isMultiple(props)
		? selectionText
		: (current?.label ?? display ?? (isSingle(props) ? (props.value ?? '') : ''))}
	<CopyText {id} text={label}>
		{#if label === ''}<span class="text-muted-foreground">{t('none')}</span>{:else}{label}{/if}
	</CopyText>
{:else}
	<Popover.Root {open} on_open_change={toggle}>
		<Popover.Trigger
			{id}
			{disabled}
			role="combobox"
			aria-expanded={open}
			aria-label={props.multiple && selectionText
				? `${ariaLabel ?? placeholder ?? t('select')}: ${selectionText}`
				: ariaLabel}
			title={props.multiple ? selectionText : undefined}
			aria-invalid={invalid ? 'true' : undefined}
			class={cn(variant === 'ghost' ? GHOST : SELECT_TRIGGER, className)}
		>
			{#if trigger}{@render trigger(current ?? null)}{:else}
				<span
					class={cn(
						'flex min-w-0 flex-1 items-center gap-1.5',
						(props.multiple ? selectedValues.length === 0 : current === undefined) &&
							display === undefined &&
							'text-muted-foreground'
					)}
				>
					{#if current?.icon}<Icon icon={current.icon} class={CONTROL_ICON} />{/if}
					<span class="min-w-0 flex-1 truncate"
						>{(props.multiple ? multiLabel || undefined : current?.label) ??
							display ??
							placeholder ??
							t('select')}</span
					>
					{#if !props.multiple && current?.suffix}<span
							class="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
							>{current.suffix}</span
						>{/if}
					{@render badge?.()}
				</span>
				<Icon icon="lucide:chevrons-up-down" class={CONTROL_ICON} />
			{/if}
		</Popover.Trigger>
		<Popover.Content
			align="start"
			same_width
			min_width={variant === 'ghost' ? 256 : 192}
			class="gap-1 p-1"
			onkeydown={keydown}
			on_open_auto_focus={(e: Event) => {
				if (coarsePointer.current) e.preventDefault();
			}}
		>
			{#if withSearch}
				<input
					bind:this={search}
					class="h-8 w-full rounded-sm border-b bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
					placeholder={t('search')}
					value={query}
					oninput={(e) => {
						query = e.currentTarget.value;
						active = 0;
						on_search?.(query);
					}}
				/>
			{/if}
			{@render header?.()}
			<ul
				bind:this={list}
				class="max-h-64 overflow-auto overscroll-contain outline-none"
				role="listbox"
				aria-multiselectable={props.multiple ? true : undefined}
				tabindex="-1"
			>
				{#if win.on}<li
						role="presentation"
						style="height:{win.before}px"
						{@attach win.anchor}
					></li>{/if}
				{#each win.slice(entries) as e, j (entryKey(win.start + j))}
					{@const i = e.i}
					{#if 'head' in e}
						<li
							role="presentation"
							class="px-2 pt-2 pb-1 text-overline text-muted-foreground"
							{@attach win.measure(entryKey(win.start + j))}
						>
							{e.head}
						</li>
					{:else}
						{@const row = e.row}
						{@const selected =
							row === null
								? false
								: isMultiple(props)
									? props.value.includes(row.value)
									: row.value === props.value}
						<li
							role="option"
							aria-selected={selected}
							data-index={i}
							data-value={row?.value ?? ''}
							{@attach win.measure(entryKey(win.start + j))}
						>
							<button
								type="button"
								tabindex="-1"
								class={cn(
									'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
									i === active && 'bg-accent text-accent-foreground'
								)}
								onmousemove={() => (active = i)}
								onclick={() => choose(row)}
							>
								{#if row === null}
									<span class="flex-1 text-muted-foreground">{t('none')}</span>
								{:else}
									{#if lead}{@render lead(row)}{:else if row.icon}<Icon
											icon={row.icon}
											class="size-4 shrink-0 text-muted-foreground"
										/>{/if}
									<span class="min-w-0 flex-1">
										<span class="block truncate">{row.label}</span>
										{#if row.description}<span class="block truncate text-xs text-muted-foreground"
												>{row.description}</span
											>{/if}
									</span>
									{#if row.suffix}<span
											class="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
											>{row.suffix}</span
										>{/if}
									{#if props.multiple}<span
											aria-hidden="true"
											class={cn(
												'flex size-4 shrink-0 items-center justify-center rounded border',
												selected && 'border-primary bg-primary text-primary-foreground'
											)}
											>{#if selected}<Icon icon="lucide:check" class="size-3" />{/if}</span
										>{:else if selected || row.suffix}<span
											class="flex size-3.5 shrink-0 items-center justify-center"
											aria-hidden="true"
											>{#if selected}<Icon icon="lucide:check" class="size-3.5" />{/if}</span
										>{/if}
								{/if}
							</button>
						</li>
					{/if}
				{:else}
					<li
						class={!loading && !failed && empty ? undefined : 'p-2 text-xs text-muted-foreground'}
					>
						{#if !loading && !failed && empty}{@render empty()}{:else}{loading
								? t('search')
								: failed
									? t('optionsUnavailable')
									: t('noResults')}{/if}
					</li>
				{/each}
				{#if win.after > 0}<li role="presentation" style="height:{win.after}px"></li>{/if}
			</ul>
			{@render footer?.()}
		</Popover.Content>
	</Popover.Root>
{/if}
