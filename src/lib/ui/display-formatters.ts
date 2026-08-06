/**
 * Read-only formatters for the values the app pages surface in table cells — the JSONB variants,
 * and every date this workspace prints.
 *
 * Every formatter parses defensively: a table cell must never throw on a row whose variant was
 * written by an older definition. There is no writing here — presentation only.
 */
import { humanize } from '@norbital-ai/std/string';
import type { TenantI18nKeys } from '$pod/i18n-keys';
import type { Translator } from './roster/roster-month.js';
import { PAYROLL_TIME_ZONE, calendarDateInTimeZone, calendarDayKey } from './calendar.js';
import { componentDefinitionSchema } from '../../custom-types/component_definition/+definition.js';
import { entryOriginSchema } from '../../custom-types/entry_origin/+definition.js';
import { holidayScopeSchema } from '../../custom-types/holiday_scope/+definition.js';
import { leaveAccrualSchema } from '../../custom-types/leave_accrual/+definition.js';
import { leavePayrollEffectSchema } from '../../custom-types/leave_payroll_effect/+definition.js';
import { moneySchema } from '../../custom-types/money/+definition.js';
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
export function formatDurationHours(value: unknown, t: Translator): string {
	if (value == null || value === '') return '—';
	const minutes = Number(value);
	if (!Number.isFinite(minutes)) return '—';
	return t('component.hours_short', { hours: HOURS.format(minutes / 60) });
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

export function formatEntryOrigin(value: unknown, t: Translator): string {
	const parsed = entryOriginSchema.safeParse(value);
	if (!parsed.success) return t('component.origin_invalid');
	const origin = parsed.data;
	switch (origin.kind) {
		case 'RECURRING':
			return t('component.origin_recurring', {
				range: formatEffectiveRange(origin.effective_range)
			});
		case 'ONE_OFF':
			return origin.note
				? t('component.origin_one_off_note', { note: origin.note })
				: t('component.origin_one_off');
		case 'CLAIM':
			return `${t('component.origin_claim', { date: formatCalendarDate(origin.incurred_on) })}${
				origin.evidence_file ? t('component.origin_evidence') : ''
			}`;
		case 'LOAN_INSTALMENT':
			return t('component.origin_instalment', {
				sequence: origin.sequence,
				of: origin.of
			});
		case 'REVERSAL':
			return t('component.origin_reversal', { reason: origin.reason });
		case 'ARREARS':
			return t('component.origin_arrears', { periods: origin.covers_periods.join(', ') });
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

const UNIT_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	MONEY: 'component.definition_unit_money',
	DAYS: 'component.definition_unit_days',
	HOURS: 'component.definition_unit_hours',
	RATE: 'component.definition_unit_rate'
};

const SETTLEMENT_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	PAYROLL: 'component.definition_settlement_payroll',
	COMPANY_DIRECT: 'component.definition_settlement_company'
};

const CAP_PERIOD_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	CALENDAR_YEAR: 'component.definition_cap_calendar_year',
	LEAVE_YEAR: 'component.definition_cap_leave_year',
	MONTH: 'component.definition_cap_month',
	LIFETIME: 'component.definition_cap_lifetime',
	PER_EVENT: 'component.definition_cap_per_event'
};

const DAY_TYPE_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	ORDINARY: 'component.definition_day_ordinary',
	REST_DAY: 'component.definition_day_rest',
	PUBLIC_HOLIDAY: 'component.definition_day_holiday'
};

const MEASURE_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	BEYOND_NORMAL: 'component.definition_measure_beyond',
	FROM_START_OF_DAY: 'component.definition_measure_from_start'
};

const ACCRUAL_KIND_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	MONTHLY: 'component.accrual_kind_monthly',
	UPFRONT: 'component.accrual_kind_upfront'
};

const PRORATION_BASIS_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	CALENDAR_DAYS: 'component.proration_calendar_days',
	WORKING_DAYS: 'component.proration_working_days'
};

const SELECTOR_BY_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	WAGE: 'component.selector_wage',
	WAGE_AND_MARITAL: 'component.selector_wage_marital',
	HEADCOUNT: 'component.selector_headcount'
};

const AWARD_KIND_LABELS: Readonly<Record<string, TenantI18nKeys>> = {
	PERCENT: 'component.award_kind_percent',
	FIXED: 'component.award_kind_fixed'
};

function labelOf(
	t: Translator,
	map: Readonly<Record<string, TenantI18nKeys>>,
	code: string
): string {
	const key = map[code];
	return key === undefined ? code : t(key);
}

export function formatComponentDefinition(value: unknown, t: Translator): string {
	const parsed = componentDefinitionSchema.safeParse(value);
	if (!parsed.success) return t('component.definition_invalid');
	const definition = parsed.data;
	switch (definition.source) {
		case 'ENTRY':
			return t('component.definition_entry', {
				unit: labelOf(t, UNIT_LABELS, definition.unit),
				settlement: labelOf(t, SETTLEMENT_LABELS, definition.settlement),
				cap: definition.cap
					? t('component.definition_entry_cap', {
							period: labelOf(t, CAP_PERIOD_LABELS, definition.cap.period)
						})
					: ''
			});
		case 'FORMULA':
			return t('component.definition_formula', {
				unit: labelOf(t, UNIT_LABELS, definition.unit),
				expr: definition.expr
			});
		case 'OVERTIME':
			return t('component.definition_overtime', {
				day: labelOf(t, DAY_TYPE_LABELS, definition.rule.day_type),
				measure: labelOf(t, MEASURE_LABELS, definition.rule.measure),
				from: definition.rule.band_from
			});
		case 'OVERTIME_EXCESS':
			return t('component.definition_overtime_excess', {
				day: labelOf(t, DAY_TYPE_LABELS, definition.rule.day_type),
				measure: labelOf(t, MEASURE_LABELS, definition.rule.measure),
				from: definition.rule.band_from,
				hours: definition.after_total_work_hours
			});
		case 'SCHEDULE':
			return t('component.definition_schedule', {
				reducible: definition.reducible
					? t('component.definition_reducible')
					: t('component.definition_not_reducible')
			});
		default:
			return definition satisfies never;
	}
}

export function formatLeaveAccrual(value: unknown, t: Translator): string {
	const parsed = leaveAccrualSchema.safeParse(value);
	if (!parsed.success) return t('component.accrual_invalid');
	const accrual = parsed.data;
	if (accrual.kind === 'PER_EVENT') return t('component.accrual_per_event');
	const carry = accrual.carry
		? t('component.accrual_carry', {
				days: accrual.carry.limit_days,
				months: accrual.carry.expiry_months
			})
		: t('component.accrual_no_carry');
	return `${labelOf(t, ACCRUAL_KIND_LABELS, accrual.kind)}${carry}`;
}

export function formatLeavePayrollEffect(value: unknown, t: Translator): string {
	const parsed = leavePayrollEffectSchema.safeParse(value);
	if (!parsed.success) return t('component.effect_invalid');
	return parsed.data.kind === 'PAID' ? t('component.effect_paid') : t('component.effect_unpaid');
}

export function formatRepaymentSchedule(value: unknown, t: Translator): string {
	const parsed = repaymentScheduleSchema.safeParse(value);
	if (!parsed.success) return t('component.schedule_invalid');
	const schedule = parsed.data;
	const total = schedule.reduce((sum, entry) => sum + entry.amount, 0);
	return t('component.schedule_instalments', {
		count: schedule.length,
		s: schedule.length === 1 ? '' : 's',
		total: DECIMAL.format(total)
	});
}

/** Total the schedule commits to repay — the denominator of "settled". */
export function repaymentScheduleTotal(value: unknown): number | null {
	const parsed = repaymentScheduleSchema.safeParse(value);
	return parsed.success ? parsed.data.reduce((sum, entry) => sum + entry.amount, 0) : null;
}

export function formatHolidayScope(value: unknown, t: Translator): string {
	const parsed = holidayScopeSchema.safeParse(value);
	if (!parsed.success) return t('component.scope_invalid');
	return parsed.data.kind === 'NATIONAL'
		? t('component.scope_national')
		: t('component.scope_regional', { locations: parsed.data.location_codes.join(', ') });
}

export function formatProrationBasis(value: unknown, t: Translator): string {
	const parsed = prorationBasisSchema.safeParse(value);
	if (!parsed.success) return t('component.proration_invalid');
	return parsed.data.by === 'FIXED_DAYS'
		? t('component.proration_fixed', { days: parsed.data.days })
		: labelOf(t, PRORATION_BASIS_LABELS, parsed.data.by);
}

export function formatRateSelector(value: unknown, t: Translator): string {
	const parsed = rateSelectorSchema.safeParse(value);
	if (!parsed.success) return t('component.selector_invalid');
	const selector = parsed.data;
	if (selector.by === 'RISK_CLASS')
		return t('component.selector_risk_class', { class: selector.class });
	const band = `${selector.from} → ${selector.to ?? '∞'}`;
	if (selector.by === 'WAGE_AND_AGE')
		return t('component.selector_wage_age', {
			range: band,
			from: selector.age_from,
			to: selector.age_to ?? '∞'
		});
	return `${labelOf(t, SELECTOR_BY_LABELS, selector.by)} ${band}`;
}

export function formatRateAward(value: unknown, t: Translator): string {
	const parsed = rateAwardSchema.safeParse(value);
	if (!parsed.success) return t('component.award_invalid');
	const award = parsed.data;
	if (award.kind === 'PROGRESSIVE')
		return t('component.award_progressive', {
			rate: award.rate,
			constant: DECIMAL.format(Math.abs(award.constant))
		});
	const unit = award.kind === 'PERCENT' ? '%' : '';
	return t('component.award_employee_employer', {
		kind: labelOf(t, AWARD_KIND_LABELS, award.kind),
		employee: award.employee,
		employer: award.employer,
		unit
	});
}

export function formatOvertimeBand(value: unknown, t: Translator): string {
	const parsed = overtimeBandSchema.safeParse(value);
	if (!parsed.success) return t('component.band_invalid');
	const band = parsed.data;
	return band.measure === 'BEYOND_NORMAL'
		? t('component.band_beyond_normal', {
				from: band.from_hours,
				to: band.to_hours ?? '∞'
			})
		: t('component.band_from_day_start', { from: band.from_fraction, to: band.to_fraction ?? '∞' });
}

export function formatOvertimeAward(value: unknown, t: Translator): string {
	const parsed = overtimeAwardSchema.safeParse(value);
	if (!parsed.success) return t('component.award_invalid');
	const award = parsed.data;
	return award.kind === 'HOURLY_MULTIPLE'
		? t('component.award_hourly_multiple', { multiple: award.multiple })
		: t('component.award_day_multiple', { multiple: award.multiple });
}

/**
 * A `money` value, printed with its own currency rather than the reader's.
 *
 * A statutory ceiling is a figure in one named currency, and dropping the code would let an
 * operator read a Malaysian ringgit threshold as though it were theirs.
 */
export function formatMoney(value: unknown, t: Translator): string {
	const parsed = moneySchema().safeParse(value);
	if (!parsed.success) return t('component.money_invalid');
	return `${parsed.data.currency} ${DECIMAL.format(parsed.data.value)}`;
}

/**
 * A `text[]` of work categories. An empty array is printed as "None" and never as blank, because a
 * blank cell reads as "nobody filled this in" when it in fact means "the statute names nobody".
 */
export function formatCategories(value: unknown, t: Translator): string {
	if (!Array.isArray(value) || value.length === 0) return t('component.categories_none');
	return value.map((entry) => humanize(String(entry))).join(', ');
}

export function formatStatutoryFactStatus(value: unknown, t: Translator): string {
	const parsed = statutoryFactStatusSchema.safeParse(value);
	if (!parsed.success) return t('component.status_invalid');
	const status = parsed.data;
	return status.kind === 'REGISTERED'
		? `${t('component.status_registered', { reference: status.reference_number })}${
				status.rate_override == null
					? ''
					: t('component.status_override', { rate: status.rate_override })
			}`
		: t('component.status_not_registered', { reason: status.reason });
}
