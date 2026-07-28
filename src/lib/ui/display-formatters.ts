/**
 * Read-only formatters for the JSONB variants the app pages surface in table cells.
 *
 * Every formatter parses defensively: a table cell must never throw on a row whose variant was
 * written by an older definition. There is no writing here — presentation only.
 */
import { humanize } from '@norbital-ai/std/string';
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

/** `YYYY-MM` → a readable month, used for `payroll_runs.period` and `component_entries.pay_period`. */
export function formatPayPeriod(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return '—';
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(new Date(`${value}-01T00:00:00.000Z`));
}

/** A `dateRange()` value `{ start, end }` of UTC ISO instants. */
export function formatEffectiveRange(value: unknown): string {
	if (value == null || typeof value !== 'object') return '—';
	const start = Reflect.get(value, 'start');
	const end = Reflect.get(value, 'end');
	const bound = (instant: unknown, fallback: string) =>
		typeof instant === 'string' && instant !== '' ? instant.slice(0, 10) : fallback;
	return `${bound(start, '…')} → ${bound(end, '∞')}`;
}

export function formatEntryOrigin(value: unknown): string {
	const parsed = entryOriginSchema.safeParse(value);
	if (!parsed.success) return 'Invalid origin';
	const origin = parsed.data;
	switch (origin.kind) {
		case 'STANDING':
			return `Standing · ${formatEffectiveRange(origin.effective_range)}`;
		case 'ONE_OFF':
			return origin.note ? `One-off · ${origin.note}` : 'One-off';
		case 'CLAIM':
			return `Claim · incurred ${origin.incurred_on}${origin.evidence_file ? ' · evidence attached' : ''}`;
		case 'INSTALMENT':
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
	return `${schedule.count} × ${DECIMAL.format(schedule.instalment_amount)} from ${schedule.first_period}`;
}

/** Total the schedule commits to repay — the denominator of "settled". */
export function repaymentScheduleTotal(value: unknown): number | null {
	const parsed = repaymentScheduleSchema.safeParse(value);
	return parsed.success ? parsed.data.instalment_amount * parsed.data.count : null;
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
