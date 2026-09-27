<script lang="ts">
	// One year, month or week: a trigger that reads like a field and a popover of one page of units (12 years, a year's
	// months, a month's week rows), paged from its header — the day calendar's shape at a coarser precision. The value is
	// the unit's first day (`YYYY-MM-DD`, weeks from Monday).
	import Icon from '@iconify/svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { cn, uiText } from '../primitives/utils.js';
	import { CONTROL } from './classes.js';
	import { useKinds } from './context.js';
	import { pageStep, unitEnd, unitPage, unitStart, type Unit } from './precision.js';

	let { unit, value, onChange, id, disabled = false, invalid = false, min, max }: {
		unit: Unit; value: string | null; onChange(next: string | null): void; id?: string; disabled?: boolean; invalid?: boolean;
		/** Bounds as dates: a unit wholly outside them is disabled. */ min?: string; max?: string;
	} = $props();
	const locale = useKinds().locale;
	const t = uiText();
	const now = new Date();
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	let open = $state(false);
	// the page shown follows the value and is moved by the arrows until the value moves again
	let anchor = $derived(value ?? today);
	const cells = $derived(unitPage(anchor, unit));
	const utc = (d: string) => new Date(`${d}T00:00:00Z`);
	const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...o, timeZone: 'UTC' });
	function name(d: string, long: boolean): string {
		if (unit === 'year') return d.slice(0, 4);
		if (unit === 'month') return fmt(long ? { month: 'long', year: 'numeric' } : { month: 'short' }).format(utc(d));
		return fmt(long ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }).formatRange(utc(d), utc(unitEnd(d, 'week')));
	}
	const heading = $derived(unit === 'year' ? `${cells[0]!.slice(0, 4)} – ${cells.at(-1)!.slice(0, 4)}` : unit === 'month' ? anchor.slice(0, 4)
		: fmt({ month: 'long', year: 'numeric' }).format(utc(anchor)));
	const off = (d: string) => (min !== undefined && unitEnd(d, unit) < min) || (max !== undefined && d > max);
	const current = $derived(unitStart(today, unit));
</script>

<Popover.Root bind:open>
	<Popover.Trigger {id} {disabled} aria-invalid={invalid ? 'true' : undefined} data-unit-picker={unit} data-value={value ?? ''}
		class={cn(CONTROL, 'flex items-center gap-2 text-left font-normal', value === null && 'text-muted-foreground')}>
		<Icon icon="lucide:calendar" class="size-4 shrink-0 text-muted-foreground" />
		<span class="truncate">{value === null ? t('select') : name(value, true)}</span>
	</Popover.Trigger>
	<Popover.Content align="start" class="w-auto p-3">
		<div class="flex items-center justify-between gap-2">
			<button type="button" class="grid size-7 place-items-center rounded-sm hover:bg-accent" aria-label="Previous" onclick={() => (anchor = pageStep(anchor, unit, -1))}><Icon icon="lucide:chevron-left" class="size-4" /></button>
			<span class="text-sm font-medium tabular-nums">{heading}</span>
			<button type="button" class="grid size-7 place-items-center rounded-sm hover:bg-accent" aria-label="Next" onclick={() => (anchor = pageStep(anchor, unit, 1))}><Icon icon="lucide:chevron-right" class="size-4" /></button>
		</div>
		<div class={cn('mt-2 grid gap-1', unit === 'week' ? 'grid-cols-1' : 'grid-cols-4')} role="grid">
			{#each cells as d (d)}
				<button type="button" role="gridcell" aria-selected={d === value} data-unit={d} disabled={off(d)}
					class={cn('h-9 min-w-14 rounded-md px-2 text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-40', unit === 'week' && 'text-left tabular-nums',
						d === value && 'bg-primary text-primary-foreground hover:bg-primary', d === current && d !== value && 'font-semibold text-primary')}
					onclick={() => { onChange(d); open = false; }}>{name(d, false)}</button>
			{/each}
		</div>
	</Popover.Content>
</Popover.Root>
