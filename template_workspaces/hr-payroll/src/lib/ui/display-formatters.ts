/**
 * Read-only formatters for the values the app pages surface in table cells — the JSONB variants,
 * and every date this workspace prints.
 *
 * Every formatter parses defensively: a table cell must never throw on a row whose variant was
 * written by an older definition. There is no writing here — presentation only.
 */
import { humanize } from '@norbital-ai/std/string';
import { PAYROLL_TIME_ZONE, calendarDateInTimeZone, calendarDayKey } from './calendar.js';
import { componentDefinitionSchema } from '../../custom-types/component_definition/+definition.js';
import { entryOriginSchema } from '../../custom-types/entry_origin/+definition.js';
import { holidayScopeSchema } from '../../custom-types/holiday_scope/+definition.js';
import { leaveAccrualSchema } from '../../custom-types/leave_accrual/+definition.js';
import { leavePayrollEffectSchema } from '../../custom-types/leave_payroll_effect/+definition.js';
import { overtimeAwardSchema } from '../../custom-types/overtime_award/+definition.js';
import { overtimeBandSchema } from '../../custom-types/overtime_band/+definition.js';
import { prorationBasisSchema } from '../../custom-types/proration_basis/+definition.js';
import { rateAwardSchema } from '../../custom-types/rate_award/+definition.js';
import { rateSelectorSchema } from '../../custom-types/rate_selector/+definition.js';
import { repaymentScheduleSchema } from '../../custom-types/repayment_schedule/+definition.js';
import { statutoryFactStatusSchema } from '../../custom-types/statutory_fact_status/+definition.js';

const DECIMAL = new Intl.NumberFormat(undefined, {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

/** A `numeric()` column arrives as a string; render it without inventing precision. */
export function formatNumeric(value: unknown): string {
	if (value == null || value === '') return '—';
	const parsed = Number(value);
	return Number.isFinite(parsed) ? DECIMAL.format(parsed) : String(value);
}

const HOURS = new Intl.NumberFormat(undefined, {
	minimumFractionDigits: 0,
	maximumFractionDigits: 2
});

/**
 * An integer-minutes column presented as hours.
 *
 * The column stays minutes — minutes are the exact unit the overtime and export arithmetic measures
 * in, and every half-hour a rota actually uses is a whole number of them. Only the label the
 * operator reads changes, so no stored value is reinterpreted.
 *
 * Deliberately *not* rounded to the half hour: the half-hour step belongs to the input, which is
 * where the operator's intent is expressed. A row that already holds 45 minutes must read `0.75 h`
 * and not be quietly reported as `0.5 h` — display that disagrees with storage is how a payroll
 * dispute starts.
 */
export function formatDurationHours(value: unknown): string {
	if (value == null || value === '') return '—';
	const minutes = Number(value);
	if (!Number.isFinite(minutes)) return '—';
	return `${HOURS.format(minutes / 60)} h`;
}

const MONTH_NAMES = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
] as const;

/**
 * A `YYYY-MM-DD` calendar day from a `date()` column value, or `null` when there is not one.
 *
 * Local PGlite reads of a `date()` column yield a `Date` at UTC midnight; wire payloads yield the
 * calendar string, sometimes with the `T00:00:00.000Z` suffix still attached. Strings are read as
 * characters and never routed through `Date` — turning a calendar day into an instant and back is
 * exactly how `dates-and-time.md` says a birthday moves.
 */
function calendarDayFrom(value: unknown): string | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : calendarDayKey(value);
	}
	if (typeof value !== 'string') return null;
	return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/**
 * The one date format this workspace prints: **`05 Aug 2026`** — day, month, year.
 *
 * Every on-screen date goes through here so the workspace never shows two shapes for the same
 * value. The month is a *name*, not a number, because this template serves Malaysian, Philippine
 * and Indonesian payroll in one interface: `05/08/2026` reads as 5 August to one operator and
 * 8 May to the next, and a misread pay date or work date is a real payroll error. The day is
 * zero-padded so the column stays a fixed width down a table.
 *
 * The month name is fixed, not locale-derived: `Intl` with the viewer's locale would put the month
 * first for a viewer in the United States, which is the ambiguity this format exists to remove.
 *
 * Takes a **calendar day**. Resolve an instant to a day first — see `formatInstant` for values that
 * are genuinely moments in time.
 */
export function formatCalendarDate(value: unknown): string {
	const day = calendarDayFrom(value);
	if (day === null) return '—';
	const month = MONTH_NAMES[Number(day.slice(5, 7)) - 1];
	if (month === undefined) return '—';
	return `${day.slice(8, 10)} ${month} ${day.slice(0, 4)}`;
}

/**
 * A `timestamp()` instant as `05 Aug 2026, 14:30` **in the viewer's timezone**.
 *
 * An instant is a moment, so unlike a calendar day it is meant to move with the viewer — a clock-in
 * recorded at 09:00 in Kuala Lumpur is a different wall-clock reading in Manila, and both are true.
 * The date part matches `formatCalendarDate`, and the clock is 24-hour so `05 Aug 2026, 01:30`
 * cannot be mistaken for the afternoon.
 */
export function formatInstant(value: unknown): string {
	const at = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
	if (at === null || Number.isNaN(at.getTime())) return '—';
	const parts = new Intl.DateTimeFormat('en-GB', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(at);
	const field = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	const month = MONTH_NAMES[Number(field('month')) - 1];
	if (month === undefined) return '—';
	return `${field('day')} ${month} ${field('year')}, ${field('hour')}:${field('minute')}`;
}

/** `YYYY-MM` → a readable month, used for `payroll_runs.period` and `component_entries.pay_period`. */
export function formatPayPeriod(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return '—';
	const month = MONTH_NAMES[Number(value.slice(5, 7)) - 1];
	return month === undefined ? '—' : `${month} ${value.slice(0, 4)}`;
}

/**
 * A `dateRange()` value `{ start, end }` of UTC ISO instants, as the two calendar days an operator
 * picked.
 *
 * The bound is an *instant*, so it is resolved through the payroll timezone rather than sliced.
 * `'2026-03-01'` picked in Kuala Lumpur is stored as `2026-02-28T16:00:00.000Z`; taking the first
 * ten characters of that would report the range as starting the day before it does, and effective
 * dating is what decides which rate row prices a run. This is the same resolution the
 * `entry_origin` renderer already performs.
 */
export function formatEffectiveRange(value: unknown): string {
	if (value == null || typeof value !== 'object') return '—';
	const bound = (instant: unknown, fallback: string) => {
		if (typeof instant !== 'string' || instant === '') return fallback;
		const at = new Date(instant);
		if (Number.isNaN(at.getTime())) return fallback;
		return formatCalendarDate(calendarDateInTimeZone(at, PAYROLL_TIME_ZONE));
	};
	return `${bound(Reflect.get(value, 'start'), '…')} → ${bound(Reflect.get(value, 'end'), '∞')}`;
}

export function formatEntryOrigin(value: unknown): string {
	const parsed = entryOriginSchema.safeParse(value);
	if (!parsed.success) return 'Invalid origin';
	const origin = parsed.data;
	switch (origin.kind) {
		case 'RECURRING':
			return `Recurring each pay period · ${formatEffectiveRange(origin.effective_range)}`;
		case 'ONE_OFF':
			return origin.note ? `One-off · ${origin.note}` : 'One-off';
		case 'CLAIM':
			return `Claim · incurred ${formatCalendarDate(origin.incurred_on)}${
				origin.evidence_file ? ' · evidence attached' : ''
			}`;
		case 'LOAN_INSTALMENT':
			return `Instalment ${origin.sequence} of ${origin.of}`;
		case 'REVERSAL':
			return `Reversal · ${origin.reason}`;
		case 'ARREARS':
			return `Arrears · ${origin.covers_periods.join(', ')}`;
		default:
			return origin satisfies never;
	}
}

/** The searchable free text an origin carries, if any — claims have none by design. */
export function entryOriginNote(value: unknown): string | null {
	const parsed = entryOriginSchema.safeParse(value);
	if (!parsed.success) return null;
	const origin = parsed.data;
	if (origin.kind === 'ONE_OFF') return origin.note || null;
	if (origin.kind === 'REVERSAL' || origin.kind === 'ARREARS') return origin.reason;
	return null;
}

export function formatComponentDefinition(value: unknown): string {
	const parsed = componentDefinitionSchema.safeParse(value);
	if (!parsed.success) return 'Invalid definition';
	const definition = parsed.data;
	switch (definition.source) {
		case 'ENTRY':
			return `Entry · ${humanize(definition.unit)} · ${humanize(definition.settlement)}${
				definition.cap ? ` · ${humanize(definition.cap.period)} cap` : ''
			}`;
		case 'FORMULA':
			return `Formula · ${humanize(definition.unit)} · ${definition.expr}`;
		case 'OVERTIME':
			return `Overtime · ${humanize(definition.rule.day_type)} · ${humanize(
				definition.rule.measure
			)} from ${definition.rule.band_from}`;
		case 'OVERTIME_EXCESS':
			return `Overtime excess · ${humanize(definition.rule.day_type)} · ${humanize(
				definition.rule.measure
			)} from ${definition.rule.band_from} · after ${definition.after_total_work_hours} total work hours`;
		case 'SCHEDULE':
			return `Schedule · ${definition.reducible ? 'reducible' : 'not reducible'}`;
		default:
			return definition satisfies never;
	}
}

export function formatLeaveAccrual(value: unknown): string {
	const parsed = leaveAccrualSchema.safeParse(value);
	if (!parsed.success) return 'Invalid accrual';
	const accrual = parsed.data;
	if (accrual.kind === 'PER_EVENT') return 'Per event';
	const carry = accrual.carry
		? ` · carry ${accrual.carry.limit_days} days for ${accrual.carry.expiry_months} months`
		: ' · no carry-forward';
	return `${humanize(accrual.kind)}${carry}`;
}

export function formatLeavePayrollEffect(value: unknown): string {
	const parsed = leavePayrollEffectSchema.safeParse(value);
	if (!parsed.success) return 'Invalid payroll effect';
	return parsed.data.kind === 'PAID' ? 'Paid' : 'Unpaid · deducts a pay component';
}

export function formatRepaymentSchedule(value: unknown): string {
	const parsed = repaymentScheduleSchema.safeParse(value);
	if (!parsed.success) return 'Invalid schedule';
	const schedule = parsed.data;
	const total = schedule.reduce((sum, entry) => sum + entry.amount, 0);
	return `${schedule.length} instalment${schedule.length === 1 ? '' : 's'} · ${DECIMAL.format(total)}`;
}

/** Total the schedule commits to repay — the denominator of "settled". */
export function repaymentScheduleTotal(value: unknown): number | null {
	const parsed = repaymentScheduleSchema.safeParse(value);
	return parsed.success ? parsed.data.reduce((sum, entry) => sum + entry.amount, 0) : null;
}

export function formatHolidayScope(value: unknown): string {
	const parsed = holidayScopeSchema.safeParse(value);
	if (!parsed.success) return 'Invalid scope';
	return parsed.data.kind === 'NATIONAL'
		? 'National'
		: `Regional · ${parsed.data.location_codes.join(', ')}`;
}

export function formatProrationBasis(value: unknown): string {
	const parsed = prorationBasisSchema.safeParse(value);
	if (!parsed.success) return 'Invalid proration';
	return parsed.data.by === 'FIXED_DAYS'
		? `Fixed ${parsed.data.days} days`
		: humanize(parsed.data.by);
}

export function formatRateSelector(value: unknown): string {
	const parsed = rateSelectorSchema.safeParse(value);
	if (!parsed.success) return 'Invalid selector';
	const selector = parsed.data;
	if (selector.by === 'RISK_CLASS') return `Risk class ${selector.class}`;
	const band = `${selector.from} → ${selector.to ?? '∞'}`;
	if (selector.by === 'WAGE_AND_AGE')
		return `Wage ${band} · age ${selector.age_from} → ${selector.age_to ?? '∞'}`;
	return `${humanize(selector.by)} ${band}`;
}

export function formatRateAward(value: unknown): string {
	const parsed = rateAwardSchema.safeParse(value);
	if (!parsed.success) return 'Invalid award';
	const award = parsed.data;
	if (award.kind === 'PROGRESSIVE')
		return `Progressive · ${award.rate}% less ${DECIMAL.format(Math.abs(award.constant))}`;
	const unit = award.kind === 'PERCENT' ? '%' : '';
	return `${humanize(award.kind)} · employee ${award.employee}${unit} · employer ${award.employer}${unit}`;
}

export function formatOvertimeBand(value: unknown): string {
	const parsed = overtimeBandSchema.safeParse(value);
	if (!parsed.success) return 'Invalid band';
	const band = parsed.data;
	return band.measure === 'BEYOND_NORMAL'
		? `Beyond normal ${band.from_hours}h → ${band.to_hours ?? '∞'}h`
		: `From start of day ${band.from_fraction} → ${band.to_fraction ?? '∞'}`;
}

export function formatOvertimeAward(value: unknown): string {
	const parsed = overtimeAwardSchema.safeParse(value);
	if (!parsed.success) return 'Invalid award';
	const award = parsed.data;
	return award.kind === 'HOURLY_MULTIPLE'
		? `${award.multiple}× hourly rate`
		: `${award.multiple}× day wage`;
}

export function formatStatutoryFactStatus(value: unknown): string {
	const parsed = statutoryFactStatusSchema.safeParse(value);
	if (!parsed.success) return 'Invalid status';
	const status = parsed.data;
	return status.kind === 'REGISTERED'
		? `Registered · ${status.reference_number}${
				status.rate_override == null ? '' : ` · override ${status.rate_override}`
			}`
		: `Not registered · ${status.reason}`;
}
