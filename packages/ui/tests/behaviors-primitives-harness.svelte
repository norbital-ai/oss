<script lang="ts">
	import { CalendarDate, Time, type DateValue } from '@internationalized/date';
	import {
		Debounced,
		PersistedState,
		create_calendar,
		create_date_field,
		create_floating,
		create_pin_input,
		create_time_field,
		portal,
		use_debounce,
		watch,
		type CalendarRange
	} from '../src/behaviors/index.js';
	import PortalConfig from '../src/primitives/portal-config.svelte';

	let {
		portal_host,
		on_watch_log,
		on_pin_complete,
		on_debounced_call,
		on_float_dismiss
	}: {
		portal_host: HTMLElement;
		on_watch_log: (entry: string) => void;
		on_pin_complete: (code: string) => void;
		on_debounced_call: (v: string) => void;
		on_float_dismiss: (reason: string) => void;
	} = $props();

	// 1. Reactive utilities: watch, watch.pre, Debounced, use_debounce, PersistedState
	let count = $state(1);
	let tag = $state('a');
	watch(
		() => count,
		(cur, prev) => {
			on_watch_log(`eager:${cur}:${prev ?? 'none'}`);
		}
	);
	watch(
		[() => count, () => tag],
		([c, t], prev) => {
			on_watch_log(`tuple:${c}/${t}:${prev ? `${prev[0]}/${prev[1]}` : 'none'}`);
		},
		{ lazy: true }
	);
	watch.pre(
		() => count,
		(cur) => {
			on_watch_log(`pre:${cur}`);
		},
		{ once: true }
	);

	const debouncedCount = new Debounced(() => count, 30);
	const runDebounced = use_debounce((v: string) => on_debounced_call(v), 30);
	const persisted = new PersistedState('nb:test:pref', 'light');

	// 2. Floating
	let floatOpen = $state(false);
	let floatSide = $state<'bottom' | 'top'>('bottom');
	const floating = create_floating({
		open: () => floatOpen,
		side: () => floatSide,
		align: () => 'start',
		side_offset: 6,
		on_dismiss: (reason) => {
			on_float_dismiss(reason);
			floatOpen = false;
		}
	});

	// 3. Portal
	let portalDisabled = $state(false);

	// 4. Pin input
	let pinValue = $state('');
	const pin = create_pin_input({
		length: 4,
		value: () => pinValue,
		on_value_change: (next) => (pinValue = next),
		on_complete: (code) => on_pin_complete(code)
	});

	// 5. Date field
	let dateValue = $state<DateValue | undefined>(new CalendarDate(2026, 3, 15));
	const dateField = create_date_field({
		value: () => dateValue,
		on_change: (next) => (dateValue = next),
		granularity: () => 'day',
		locale: () => 'en-US',
		min: () => new CalendarDate(2026, 1, 1),
		max: () => new CalendarDate(2026, 12, 31)
	});

	// 6. Time field
	let timeValue = $state<Time | undefined>(new Time(9, 30));
	const timeField = create_time_field({
		value: () => timeValue,
		on_change: (next) => (timeValue = next),
		granularity: () => 'minute'
	});

	// 7. Single & range calendars
	let singleCalVal = $state<DateValue | undefined>(new CalendarDate(2026, 4, 10));
	let singlePlaceholder = $state<DateValue | undefined>(new CalendarDate(2026, 4, 1));
	const singleCal = create_calendar({
		mode: 'single',
		value: () => singleCalVal,
		placeholder: () => singlePlaceholder,
		on_placeholder_change: (next) => (singlePlaceholder = next),
		on_select: (d) => (singleCalVal = d),
		locale: () => 'en-US'
	});

	let rangeVal = $state<CalendarRange>({ start: undefined, end: undefined });
	let rangePlaceholder = $state<DateValue | undefined>(new CalendarDate(2026, 5, 1));
	const rangeCal = create_calendar({
		mode: 'range',
		range: () => rangeVal,
		placeholder: () => rangePlaceholder,
		on_placeholder_change: (next) => (rangePlaceholder = next),
		number_of_months: () => 2,
		on_range_change: (next) => (rangeVal = next),
		locale: () => 'en-US'
	});
</script>

<div>
	<button type="button" data-testid="inc-count" onclick={() => (count += 1)}>inc</button>
	<button type="button" data-testid="flip-tag" onclick={() => (tag = 'b')}>tag</button>
	<button type="button" data-testid="call-debounce" onclick={() => runDebounced(`v-${count}`)}>
		debounce
	</button>
	<button
		type="button"
		data-testid="toggle-persist"
		onclick={() => (persisted.current = persisted.current === 'light' ? 'dark' : 'light')}
	>
		persist
	</button>
	<span data-testid="debounced-val">{debouncedCount.current}</span>
	<span data-testid="persisted-val">{persisted.current}</span>

	<button
		type="button"
		data-testid="float-anchor"
		{@attach floating.anchor}
		onclick={() => (floatOpen = !floatOpen)}
	>
		anchor
	</button>
	{#if floatOpen}
		<div
			data-testid="float-content"
			data-side={floating.side}
			style={floating.style}
			{@attach floating.content}
		>
			floating body
		</div>
	{/if}

	<PortalConfig to={portal_host}>
		<button
			type="button"
			data-testid="toggle-portal-disabled"
			onclick={() => (portalDisabled = !portalDisabled)}
		>
			portal-toggle
		</button>
		<div data-testid="portal-origin">
			<div data-testid="portaled-box" {@attach portal({ disabled: portalDisabled })}>
				portaled text
			</div>
		</div>
	</PortalConfig>

	<div data-testid="pin-wrap" data-pin-value={pinValue}>
		<input data-testid="pin-input" {...pin.input_attrs()} />
		{#each pin.cells as cell (cell.index)}
			<span data-pin-cell={cell.index} data-active={cell.is_active ? 'true' : undefined}>
				{cell.char ?? ''}
			</span>
		{/each}
	</div>

	<div data-testid="date-field" data-date-value={dateValue?.toString() ?? ''}>
		{#each dateField.segments as seg, i (i)}
			<span {@attach dateField.segment_ref(seg.part)} {...dateField.segment_attrs(seg)}>
				{seg.value}
			</span>
		{/each}
	</div>

	<div data-testid="time-field" data-time-value={timeValue?.toString() ?? ''}>
		{#each timeField.segments as seg, i (i)}
			<span {@attach timeField.segment_ref(seg.part)} {...timeField.segment_attrs(seg)}>
				{seg.value}
			</span>
		{/each}
	</div>

	<div
		data-testid="single-cal"
		data-selected={singleCalVal?.toString() ?? ''}
		data-month={singleCal.months[0]?.value.toString() ?? ''}
	>
		<button type="button" data-testid="single-prev" onclick={() => singleCal.prev_month()}>prev</button>
		<button type="button" data-testid="single-next" onclick={() => singleCal.next_month()}>next</button>
		{#each singleCal.months as month (month.value.toString())}
			{#each month.weeks as week}
				{#each week as day (day.toString())}
					<button
						type="button"
						data-single-day={day.toString()}
						{...singleCal.day_attrs(day, month.value)}
					>
						{day.day}
					</button>
				{/each}
			{/each}
		{/each}
	</div>

	<div
		data-testid="range-cal"
		data-months={rangeCal.months.length}
		data-start={rangeVal.start?.toString() ?? ''}
		data-end={rangeVal.end?.toString() ?? ''}
	>
		{#each rangeCal.months as month (month.value.toString())}
			{#each month.weeks as week}
				{#each week as day (day.toString())}
					<button
						type="button"
						data-range-day={day.toString()}
						{...rangeCal.day_attrs(day, month.value)}
					>
						{day.day}
					</button>
				{/each}
			{/each}
		{/each}
	</div>
</div>
