// Composable date-field, time-field and calendar behaviors built directly on `@internationalized/date`.
// Replaces third-party segmented date/time pickers with clean, locale-aware Svelte-5 runes:
// numeric typing with multi-digit buffering (no premature commit on leading "0"), ArrowUp/Down
// cycling, ArrowLeft/Right segment movement, Backspace clearing, and single/range calendar grids.
import {
	CalendarDate,
	Time,
	ZonedDateTime,
	endOfMonth,
	getDayOfWeek,
	getLocalTimeZone,
	isSameDay,
	isSameMonth,
	isToday,
	startOfMonth,
	startOfWeek,
	today,
	toCalendarDate,
	type DateValue
} from '@internationalized/date';
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';

/** Editable or literal segment kind inside a segmented date or time field. */
export type SegmentPart = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'literal';

/** One rendered segment of a segmented date or time field. */
export type DateTimeSegment = {
	/** Segment type (`'year'`, `'month'`, `'day'`, `'hour'`, `'minute'`, or `'literal'`). */
	readonly part: SegmentPart;
	/** Displayed text (zero-padded value, placeholder token or separator). */
	readonly value: string;
	/** Whether the segment is currently showing its placeholder rather than a set value. */
	readonly placeholder: boolean;
};

/** Options for `create_date_field`. */
export type DateFieldOptions = {
	/** Controlled `DateValue` getter. */
	readonly value: () => DateValue | undefined;
	/** Called when the complete date/time value changes (or clears to `undefined`). */
	readonly on_change: (next: DateValue | undefined) => void;
	/** Editing precision: `'day'` (date only), `'hour'` (date + hour), or `'minute'` (date + hour + minute). */
	readonly granularity?: () => 'day' | 'hour' | 'minute';
	/** BCP-47 locale for segment order and separators (default `'en-US'`). */
	readonly locale?: () => string | undefined;
	/** Disabled state. */
	readonly disabled?: () => boolean;
	/** Minimum allowed date value. */
	readonly min?: () => DateValue | undefined;
	/** Maximum allowed date value. */
	readonly max?: () => DateValue | undefined;
};

/** Return value of `create_date_field`. */
export type DateFieldBehavior = ReturnType<typeof create_date_field>;

/** Options for `create_time_field`. */
export type TimeFieldOptions = {
	/** Controlled `Time` getter. */
	readonly value: () => Time | undefined;
	/** Called when the time value changes (or clears to `undefined`). */
	readonly on_change: (next: Time | undefined) => void;
	/** Editing precision: `'hour'` or `'minute'` (default `'minute'`). */
	readonly granularity?: () => 'hour' | 'minute';
	/** Disabled state. */
	readonly disabled?: () => boolean;
};

/** Return value of `create_time_field`. */
export type TimeFieldBehavior = ReturnType<typeof create_time_field>;

/** Selection mode for `create_calendar`. */
export type CalendarMode = 'single' | 'range';

/** Start and end of a calendar date range. */
export type CalendarRange = {
	/** First selected date, if any. */
	readonly start: DateValue | undefined;
	/** Last selected date, if any. */
	readonly end: DateValue | undefined;
};

/** One month grid returned by `create_calendar`. */
export type CalendarMonth = {
	/** First day of this month. */
	readonly value: CalendarDate;
	/** Rows of 7 `CalendarDate` cells (including leading/trailing outside-month days). */
	readonly weeks: readonly (readonly CalendarDate[])[];
};

/** Options for `create_calendar`. */
export type CalendarOptions = {
	/** Single-day or date-range selection mode (default `'single'`). */
	readonly mode?: CalendarMode | (() => CalendarMode);
	/** Selected single date when `mode === 'single'`. */
	readonly value?: () => DateValue | undefined;
	/** Selected range when `mode === 'range'`. */
	readonly range?: () => CalendarRange;
	/** Called on single-day selection. */
	readonly on_select?: (date: DateValue) => void;
	/** Called when range selection updates (with `{ start, end }`). */
	readonly on_range_change?: (range: CalendarRange) => void;
	/** Controlled visible anchor month. */
	readonly placeholder?: () => DateValue | undefined;
	/** Called when the visible month changes. */
	readonly on_placeholder_change?: (next: DateValue) => void;
	/** Number of side-by-side months to build (default `1`). */
	readonly number_of_months?: () => number;
	/** BCP-47 locale for weekday order and names (default `'en-US'`). */
	readonly locale?: () => string | undefined;
	/** Minimum selectable date. */
	readonly min?: () => DateValue | undefined;
	/** Maximum selectable date. */
	readonly max?: () => DateValue | undefined;
	/** Disabled state. */
	readonly disabled?: () => boolean;
};

/** Return value of `create_calendar`. */
export type CalendarBehavior = ReturnType<typeof create_calendar>;

type EditableDatePart = 'year' | 'month' | 'day' | 'hour' | 'minute';

const PLACEHOLDERS: Record<EditableDatePart, string> = {
	year: 'yyyy',
	month: 'mm',
	day: 'dd',
	hour: 'hh',
	minute: 'mm'
};

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

function dateTemplate(locale: string, granularity: 'day' | 'hour' | 'minute'): readonly { part: SegmentPart; literal?: string }[] {
	const out: { part: SegmentPart; literal?: string }[] = [];
	try {
		const parts = new Intl.DateTimeFormat(locale, {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			timeZone: 'UTC'
		}).formatToParts(new Date(Date.UTC(2026, 8, 27)));
		for (const p of parts) {
			if (p.type === 'year' || p.type === 'month' || p.type === 'day') {
				out.push({ part: p.type });
			} else if (p.type === 'literal' && out.length > 0 && out.length < 5) {
				out.push({ part: 'literal', literal: p.value });
			}
		}
	} catch {
		out.push(
			{ part: 'year' },
			{ part: 'literal', literal: '-' },
			{ part: 'month' },
			{ part: 'literal', literal: '-' },
			{ part: 'day' }
		);
	}
	if (granularity === 'hour' || granularity === 'minute') {
		out.push({ part: 'literal', literal: ', ' });
		out.push({ part: 'hour' });
		if (granularity === 'minute') {
			out.push({ part: 'literal', literal: ':' });
			out.push({ part: 'minute' });
		}
	}
	return out;
}

function segmentBounds(part: EditableDatePart, ref: DateValue): { min: number; max: number; digits: number } {
	switch (part) {
		case 'year':
			return { min: 1, max: 9999, digits: 4 };
		case 'month':
			return { min: 1, max: 12, digits: 2 };
		case 'day':
			return { min: 1, max: endOfMonth(toCalendarDate(ref)).day, digits: 2 };
		case 'hour':
			return { min: 0, max: 23, digits: 2 };
		case 'minute':
			return { min: 0, max: 59, digits: 2 };
	}
}

function readDatePart(v: DateValue, part: EditableDatePart): number {
	switch (part) {
		case 'year':
			return v.year;
		case 'month':
			return v.month;
		case 'day':
			return v.day;
		case 'hour':
			return 'hour' in v ? v.hour : 0;
		case 'minute':
			return 'minute' in v ? v.minute : 0;
	}
}

function setDatePart(v: DateValue, part: EditableDatePart, next: number): DateValue {
	if (part === 'year') return v.set({ year: next });
	if (part === 'month') return v.set({ month: next });
	if (part === 'day') return v.set({ day: next });
	if ('hour' in v) {
		return part === 'hour' ? v.set({ hour: next }) : v.set({ minute: next });
	}
	return v;
}

function defaultBase(granularity: 'day' | 'hour' | 'minute'): DateValue {
	const d = today(getLocalTimeZone());
	if (granularity === 'day') return d;
	return new ZonedDateTime(d.year, d.month, d.day, getLocalTimeZone(), 0, 0, 0, 0);
}

/**
 * Headless locale-aware segmented date/instant field behavior.
 * Supports multi-digit buffered typing (waiting for the full digit count before committing),
 * ArrowUp/Down stepping, ArrowLeft/Right segment focus and Backspace clearing.
 */
export function create_date_field(options: DateFieldOptions) {
	const nodes = new Map<EditableDatePart, HTMLElement>();
	let typingPart = $state<EditableDatePart | null>(null);
	let typingBuf = $state('');
	let draft = $state<Partial<Record<EditableDatePart, number>>>({});

	const granularity = $derived(options.granularity?.() ?? 'day');
	const locale = $derived(options.locale?.() ?? 'en-US');
	const disabled = $derived(options.disabled?.() ?? false);
	let current = $state<DateValue | undefined>(untrack(() => options.value()));
	let lastExternal = untrack(() => options.value());
	$effect(() => {
		const ext = options.value();
		if (ext?.toString() !== lastExternal?.toString()) {
			lastExternal = ext;
			current = ext;
		}
	});
	function commit(next: DateValue | undefined): void {
		current = next;
		options.on_change(next);
	}
	const template = $derived(dateTemplate(locale, granularity));
	const editableOrder = $derived(
		template
			.map((t) => t.part)
			.filter((p): p is EditableDatePart => p !== 'literal')
	);

	function clampValue(candidate: DateValue): DateValue {
		const min = options.min?.();
		const max = options.max?.();
		if (min !== undefined && candidate.compare(min) < 0) return min;
		if (max !== undefined && candidate.compare(max) > 0) return max;
		return candidate;
	}

	function flushBuffer(): void {
		if (typingPart === null || typingBuf === '') return;
		const part = typingPart;
		const num = Number(typingBuf);
		typingPart = null;
		typingBuf = '';
		if (!Number.isFinite(num)) return;
		applyPart(part, num, false);
	}

	function applyPart(part: EditableDatePart, raw: number, advance: boolean): void {
		const base = current ?? defaultBase(granularity);
		const bounds = segmentBounds(part, base);
		const clamped = Math.min(bounds.max, Math.max(bounds.min, raw));

		if (current !== undefined) {
			const next = clampValue(setDatePart(current, part, clamped));
			commit(next);
		} else {
			const nextDraft = { ...draft, [part]: clamped };
			draft = nextDraft;
			const allFilled = editableOrder.every((p) => nextDraft[p] !== undefined);
			if (allFilled) {
				let built = base;
				for (const p of editableOrder) {
					const val = nextDraft[p];
					if (val !== undefined) built = setDatePart(built, p, val);
				}
				draft = {};
				commit(clampValue(built));
			}
		}
		if (advance) moveSegment(part, 1);
	}

	function moveSegment(from: EditableDatePart, delta: 1 | -1): void {
		const idx = editableOrder.indexOf(from);
		if (idx < 0) return;
		const nextPart = editableOrder[idx + delta];
		if (nextPart !== undefined) nodes.get(nextPart)?.focus();
	}

	const segments = $derived.by((): readonly DateTimeSegment[] =>
		template.map((entry) => {
			if (entry.part === 'literal') {
				return { part: 'literal', value: entry.literal ?? '', placeholder: false };
			}
			const part = entry.part;
			if (typingPart === part && typingBuf !== '') {
				const digits = part === 'year' ? 4 : 2;
				return { part, value: typingBuf.padStart(digits, '0'), placeholder: false };
			}
			if (current !== undefined) {
				const digits = part === 'year' ? 4 : 2;
				return { part, value: pad(readDatePart(current, part), digits), placeholder: false };
			}
			const drafted = draft[part];
			if (drafted !== undefined) {
				const digits = part === 'year' ? 4 : 2;
				return { part, value: pad(drafted, digits), placeholder: false };
			}
			return { part, value: PLACEHOLDERS[part], placeholder: true };
		})
	);

	function handleKeydown(part: EditableDatePart, event: KeyboardEvent): void {
		if (disabled) return;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			flushBuffer();
			moveSegment(part, -1);
			return;
		}
		if (event.key === 'ArrowRight') {
			event.preventDefault();
			flushBuffer();
			moveSegment(part, 1);
			return;
		}
		if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault();
			flushBuffer();
			const step = event.key === 'ArrowUp' ? 1 : -1;
			const base = current ?? defaultBase(granularity);
			const next =
				current === undefined
					? base
					: part === 'year' || part === 'month' || part === 'day'
						? current.cycle(part, step)
						: 'hour' in current
							? current.cycle(part, step)
							: current;
			commit(clampValue(next));
			return;
		}
		if (event.key === 'Backspace' || event.key === 'Delete') {
			event.preventDefault();
			if (typingPart === part && typingBuf.length > 0) {
				typingBuf = typingBuf.slice(0, -1);
				if (typingBuf === '') typingPart = null;
				return;
			}
			const nextDraft = { ...draft };
			delete nextDraft[part];
			draft = nextDraft;
			if (current !== undefined) commit(undefined);
			return;
		}
		if (/^\d$/.test(event.key)) {
			event.preventDefault();
			const base = current ?? defaultBase(granularity);
			const bounds = segmentBounds(part, base);
			const nextBuf = typingPart === part ? typingBuf + event.key : event.key;
			const parsed = Number(nextBuf);

			// Commit immediately once full digit count is reached, or if appending another digit would always exceed max
			const reachedMaxDigits = nextBuf.length >= bounds.digits;
			const cannotTakeMore = nextBuf.length < bounds.digits && parsed * 10 > bounds.max && parsed >= bounds.min;

			if (reachedMaxDigits || cannotTakeMore) {
				typingPart = null;
				typingBuf = '';
				applyPart(part, parsed, true);
			} else {
				typingPart = part;
				typingBuf = nextBuf;
			}
		}
	}

	return {
		get segments() {
			return segments;
		},
		segment_ref(part: SegmentPart): Attachment<HTMLElement> {
			return (el) => {
				if (part === 'literal') return;
				nodes.set(part, el);
				return () => {
					if (nodes.get(part) === el) nodes.delete(part);
				};
			};
		},
		segment_attrs(seg: DateTimeSegment) {
			if (seg.part === 'literal') {
				return {
					'aria-hidden': true as const,
					'data-segment': 'literal' as const
				};
			}
			const part = seg.part;
			const base = current ?? defaultBase(granularity);
			const bounds = segmentBounds(part, base);
			const numeric = current !== undefined ? readDatePart(current, part) : draft[part];
			return {
				role: 'spinbutton' as const,
				tabindex: disabled ? undefined : 0,
				'data-segment': part,
				'aria-label': part,
				'aria-valuemin': bounds.min,
				'aria-valuemax': bounds.max,
				'aria-valuenow': numeric,
				'aria-valuetext': seg.placeholder ? 'Empty' : seg.value,
				'aria-disabled': disabled ? (true as const) : undefined,
				onkeydown: (e: KeyboardEvent) => handleKeydown(part, e),
				onblur: () => {
					if (typingPart === part) flushBuffer();
				}
			};
		}
	};
}

type EditableTimePart = 'hour' | 'minute';

/**
 * Headless 24-hour segmented time-of-day field behavior (`hour` and optional `minute`).
 */
export function create_time_field(options: TimeFieldOptions) {
	const nodes = new Map<EditableTimePart, HTMLElement>();
	let typingPart = $state<EditableTimePart | null>(null);
	let typingBuf = $state('');
	let draft = $state<Partial<Record<EditableTimePart, number>>>({});

	const granularity = $derived(options.granularity?.() ?? 'minute');
	const disabled = $derived(options.disabled?.() ?? false);
	let current = $state<Time | undefined>(untrack(() => options.value()));
	let lastExternal = untrack(() => options.value());
	$effect(() => {
		const ext = options.value();
		if (ext?.toString() !== lastExternal?.toString()) {
			lastExternal = ext;
			current = ext;
		}
	});
	function commit(next: Time | undefined): void {
		current = next;
		options.on_change(next);
	}
	const editableOrder = $derived<readonly EditableTimePart[]>(
		granularity === 'hour' ? ['hour'] : ['hour', 'minute']
	);

	function flushBuffer(): void {
		if (typingPart === null || typingBuf === '') return;
		const part = typingPart;
		const num = Number(typingBuf);
		typingPart = null;
		typingBuf = '';
		if (!Number.isFinite(num)) return;
		applyPart(part, num, false);
	}

	function applyPart(part: EditableTimePart, raw: number, advance: boolean): void {
		const max = part === 'hour' ? 23 : 59;
		const clamped = Math.min(max, Math.max(0, raw));
		if (current !== undefined) {
			const next =
				part === 'hour'
					? new Time(clamped, granularity === 'hour' ? 0 : current.minute)
					: new Time(current.hour, clamped);
			commit(next);
		} else {
			const nextDraft = { ...draft, [part]: clamped };
			draft = nextDraft;
			if (granularity === 'hour') {
				draft = {};
				commit(new Time(clamped, 0));
			} else if (nextDraft.hour !== undefined && nextDraft.minute !== undefined) {
				draft = {};
				commit(new Time(nextDraft.hour, nextDraft.minute));
			}
		}
		if (advance) {
			const idx = editableOrder.indexOf(part);
			const nextPart = editableOrder[idx + 1];
			if (nextPart !== undefined) nodes.get(nextPart)?.focus();
		}
	}

	const segments = $derived.by((): readonly DateTimeSegment[] => {
		const hourText =
			typingPart === 'hour' && typingBuf !== ''
				? typingBuf.padStart(2, '0')
				: current !== undefined
					? pad(current.hour)
					: draft.hour !== undefined
						? pad(draft.hour)
						: 'hh';
		const hourPlaceholder = typingPart !== 'hour' && current === undefined && draft.hour === undefined;
		const out: DateTimeSegment[] = [{ part: 'hour', value: hourText, placeholder: hourPlaceholder }];
		if (granularity === 'minute') {
			out.push({ part: 'literal', value: ':', placeholder: false });
			const minText =
				typingPart === 'minute' && typingBuf !== ''
					? typingBuf.padStart(2, '0')
					: current !== undefined
						? pad(current.minute)
						: draft.minute !== undefined
							? pad(draft.minute)
							: 'mm';
			const minPlaceholder =
				typingPart !== 'minute' && current === undefined && draft.minute === undefined;
			out.push({ part: 'minute', value: minText, placeholder: minPlaceholder });
		}
		return out;
	});

	function handleKeydown(part: EditableTimePart, event: KeyboardEvent): void {
		if (disabled) return;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			flushBuffer();
			const idx = editableOrder.indexOf(part);
			const nextPart = editableOrder[idx + (event.key === 'ArrowRight' ? 1 : -1)];
			if (nextPart !== undefined) nodes.get(nextPart)?.focus();
			return;
		}
		if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault();
			flushBuffer();
			const delta = event.key === 'ArrowUp' ? 1 : -1;
			const base = current ?? new Time(0, 0);
			commit(base.cycle(part, delta));
			return;
		}
		if (event.key === 'Backspace' || event.key === 'Delete') {
			event.preventDefault();
			if (typingPart === part && typingBuf.length > 0) {
				typingBuf = typingBuf.slice(0, -1);
				if (typingBuf === '') typingPart = null;
				return;
			}
			const nextDraft = { ...draft };
			delete nextDraft[part];
			draft = nextDraft;
			if (current !== undefined) commit(undefined);
			return;
		}
		if (/^\d$/.test(event.key)) {
			event.preventDefault();
			const max = part === 'hour' ? 23 : 59;
			const nextBuf = typingPart === part ? typingBuf + event.key : event.key;
			const parsed = Number(nextBuf);
			if (nextBuf.length >= 2 || parsed * 10 > max) {
				typingPart = null;
				typingBuf = '';
				applyPart(part, parsed, true);
			} else {
				typingPart = part;
				typingBuf = nextBuf;
			}
		}
	}

	return {
		get segments() {
			return segments;
		},
		segment_ref(part: SegmentPart): Attachment<HTMLElement> {
			return (el) => {
				if (part !== 'hour' && part !== 'minute') return;
				nodes.set(part, el);
				return () => {
					if (nodes.get(part) === el) nodes.delete(part);
				};
			};
		},
		segment_attrs(seg: DateTimeSegment) {
			if (seg.part !== 'hour' && seg.part !== 'minute') {
				return {
					'aria-hidden': true as const,
					'data-segment': 'literal' as const
				};
			}
			const part = seg.part;
			const max = part === 'hour' ? 23 : 59;
			const numeric =
				current !== undefined ? (part === 'hour' ? current.hour : current.minute) : draft[part];
			return {
				role: 'spinbutton' as const,
				tabindex: disabled ? undefined : 0,
				'data-segment': part,
				'aria-label': part,
				'aria-valuemin': 0,
				'aria-valuemax': max,
				'aria-valuenow': numeric,
				'aria-valuetext': seg.placeholder ? 'Empty' : seg.value,
				'aria-disabled': disabled ? (true as const) : undefined,
				onkeydown: (e: KeyboardEvent) => handleKeydown(part, e),
				onblur: () => {
					if (typingPart === part) flushBuffer();
				}
			};
		}
	};
}

function buildMonthGrid(monthStart: CalendarDate, locale: string): CalendarMonth {
	const first = startOfWeek(monthStart, locale);
	const lastMonthDay = endOfMonth(monthStart);
	const weeks: CalendarDate[][] = [];
	let cursor = first;
	while (cursor.compare(lastMonthDay) <= 0 || weeks.length < 5) {
		const row: CalendarDate[] = [];
		for (let i = 0; i < 7; i++) {
			row.push(cursor);
			cursor = cursor.add({ days: 1 });
		}
		weeks.push(row);
		if (cursor.compare(lastMonthDay) > 0 && weeks.length >= 5) break;
	}
	return { value: monthStart, weeks };
}

function buildWeekdays(locale: string): readonly string[] {
	const ref = startOfWeek(new CalendarDate(2026, 1, 5), locale);
	const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
	return Array.from({ length: 7 }, (_, i) => {
		const d = ref.add({ days: i });
		return fmt.format(new Date(Date.UTC(d.year, d.month - 1, d.day)));
	});
}

/**
 * Headless single-day and date-range calendar grid behavior over `@internationalized/date`.
 * Builds localized month grids, weekday headers, prev/next month controls, range hover previews
 * and keyboard Arrow/PageUp/PageDown day navigation.
 */
export function create_calendar(options: CalendarOptions) {
	const tz = getLocalTimeZone();
	let internalPlaceholder = $state<DateValue>(today(tz));
	let pendingStart = $state<CalendarDate | null>(null);
	let hovered = $state<CalendarDate | null>(null);

	const mode = $derived(typeof options.mode === 'function' ? options.mode() : (options.mode ?? 'single'));
	const locale = $derived(options.locale?.() ?? 'en-US');
	const disabled = $derived(options.disabled?.() ?? false);
	const monthCount = $derived(Math.max(1, options.number_of_months?.() ?? 1));

	const anchor = $derived.by((): CalendarDate => {
		const raw =
			options.placeholder?.() ??
			(mode === 'range' ? options.range?.().start : options.value?.()) ??
			internalPlaceholder;
		return startOfMonth(toCalendarDate(raw));
	});

	const months = $derived.by((): readonly CalendarMonth[] =>
		Array.from({ length: monthCount }, (_, i) => buildMonthGrid(anchor.add({ months: i }), locale))
	);
	const weekdays = $derived(buildWeekdays(locale));

	function setPlaceholder(next: DateValue): void {
		const normalized = startOfMonth(toCalendarDate(next));
		internalPlaceholder = normalized;
		options.on_placeholder_change?.(normalized);
	}

	function isDayDisabled(date: CalendarDate): boolean {
		if (disabled) return true;
		const min = options.min?.();
		const max = options.max?.();
		if (min !== undefined && date.compare(toCalendarDate(min)) < 0) return true;
		if (max !== undefined && date.compare(toCalendarDate(max)) > 0) return true;
		return false;
	}

	function selectDay(date: CalendarDate): void {
		if (isDayDisabled(date)) return;
		if (mode === 'single') {
			const existing = options.value?.();
			if (existing !== undefined && 'hour' in existing) {
				options.on_select?.(existing.set({ year: date.year, month: date.month, day: date.day }));
			} else {
				options.on_select?.(date);
			}
			return;
		}
		// Range mode: first click sets pendingStart (emits { start, end: undefined }), second click completes sorted range
		if (pendingStart === null) {
			pendingStart = date;
			options.on_range_change?.({ start: date, end: undefined });
		} else {
			const start = date.compare(pendingStart) < 0 ? date : pendingStart;
			const end = date.compare(pendingStart) < 0 ? pendingStart : date;
			pendingStart = null;
			hovered = null;
			options.on_range_change?.({ start, end });
		}
	}

	const activeRange = $derived.by((): { start: CalendarDate | null; end: CalendarDate | null } => {
		if (mode !== 'range') return { start: null, end: null };
		if (pendingStart !== null) {
			if (hovered !== null) {
				return hovered.compare(pendingStart) < 0
					? { start: hovered, end: pendingStart }
					: { start: pendingStart, end: hovered };
			}
			return { start: pendingStart, end: null };
		}
		const r = options.range?.();
		return {
			start: r?.start ? toCalendarDate(r.start) : null,
			end: r?.end ? toCalendarDate(r.end) : null
		};
	});

	return {
		get placeholder() {
			return anchor;
		},
		get months() {
			return months;
		},
		get weekdays() {
			return weekdays;
		},
		set_placeholder: setPlaceholder,
		prev_month() {
			setPlaceholder(anchor.subtract({ months: 1 }));
		},
		next_month() {
			setPlaceholder(anchor.add({ months: 1 }));
		},
		reset_pending() {
			pendingStart = null;
			hovered = null;
		},
		day_attrs(date: CalendarDate, month: CalendarDate) {
			const outside = !isSameMonth(date, month);
			const off = isDayDisabled(date);
			const isNow = isToday(date, tz);
			let selected = false;
			let isStart = false;
			let isEnd = false;

			if (mode === 'single') {
				const v = options.value?.();
				selected = v !== undefined && isSameDay(date, toCalendarDate(v));
			} else {
				const { start, end } = activeRange;
				isStart = start !== null && isSameDay(date, start);
				isEnd = end !== null && isSameDay(date, end);
				selected =
					isStart ||
					isEnd ||
					(start !== null && end !== null && date.compare(start) >= 0 && date.compare(end) <= 0);
			}

			return {
				role: 'button' as const,
				tabindex: outside || off ? -1 : 0,
				'data-value': date.toString(),
				'data-selected': selected ? '' : undefined,
				'data-selection-start': isStart ? '' : undefined,
				'data-selection-end': isEnd ? '' : undefined,
				'data-today': isNow ? '' : undefined,
				'data-outside-month': outside ? '' : undefined,
				'data-disabled': off ? '' : undefined,
				'aria-disabled': off ? (true as const) : undefined,
				'aria-selected': selected,
				onclick: () => {
					if (!outside && !off) selectDay(date);
				},
				onpointerenter: () => {
					if (mode === 'range' && pendingStart !== null && !outside && !off) hovered = date;
				},
				onkeydown: (e: KeyboardEvent) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						if (!outside && !off) selectDay(date);
					}
				}
			};
		}
	};
}

export { getDayOfWeek };
