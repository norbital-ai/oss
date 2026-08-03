/**
 * Leave balances, derived.
 *
 * A balance is a bank statement for days: every movement is stored, and everything else is
 * arithmetic over the date. Accrual, carry-forward and expiry are pure functions and are therefore
 * **never** written — not by a job, not on read, not as a boundary row on 1 January. A balance that
 * is only correct after a process has run is a cache, and caches go stale.
 *
 * ```
 * balance(D) = carriedIn(leaveYear(D))          derived, recursive to the hire year
 *            + accrued(leaveYearStart → D)      derived, month by month
 *            − expired(D)                       derived, oldest-first consumption
 *            + Σ ledger.days in the leave year  the only stored part
 * ```
 *
 * **The running total is rounded, never the monthly increment.** Rounding each month's 1.75 up to
 * 2.0 and summing twelve of them overstates a 21-day entitlement by three days; rounding the
 * cumulative figure is monotonic and lands exactly on the entitlement in December.
 *
 * Payroll itself reads none of this. It reads only the unpaid-leave movements in the attendance
 * window, because an unpaid day costs money whatever the balance says — a balance guard belongs at
 * request time, not at pay time (decision L9).
 */

import type { Configuration, LeaveType } from './configuration.js';
import {
	completedMonths,
	dateKey,
	monthDays,
	monthKey,
	shiftPeriod,
	type IsoDate
} from './dates.js';
import { roundHalfDay } from './rounding.js';
import { coversDate } from './effective.js';

/**
 * A ledger row as the database hands it back.
 *
 * `kind` is widened to `string | null` because a generated enum column is nullable whatever the
 * model declares. It is compared against the three known kinds rather than narrowed by assertion,
 * so an unrecognised value is simply not `TAKEN` and cannot silently become one.
 */
export type LedgerRow = {
	readonly norbital_id: string;
	readonly leave_type_id: string;
	readonly entry_date: string | Date;
	readonly kind: string | null;
	readonly days: number;
	readonly source_id: string | null;
	readonly norbital_approval_id?: string | null;
};

/** `payroll` acts on settled rows only; a new request is checked against every row. */
export type BalanceBasis = 'SETTLED' | 'PROJECTED';

function visible(row: LedgerRow, basis: BalanceBasis): boolean {
	return basis === 'PROJECTED' || row.norbital_approval_id == null;
}

/** The first day of the leave year a date falls in. */
export function leaveYearStart(date: IsoDate, startMonth: number): IsoDate {
	const month = Math.min(12, Math.max(1, Math.trunc(startMonth)));
	const year = Number(date.slice(0, 4));
	const inThisYear = Number(date.slice(5, 7)) >= month;
	return `${inThisYear ? year : year - 1}-${String(month).padStart(2, '0')}-01`;
}

/** The label of the leave year a date falls in — its starting year. */
export function leaveYearOf(date: IsoDate, startMonth: number): number {
	return Number(leaveYearStart(date, startMonth).slice(0, 4));
}

/**
 * Entitlement in days for one leave code at a service age.
 *
 * Three layers collapse to `max(statutory, company ?? statutory)`. The statutory floor is a floor:
 * a company that mis-types maternity leave as 60 days still owes 98, so compliance never depends on
 * the customer configuring correctly.
 */
export function resolveEntitlement(options: {
	readonly leaveType: LeaveType;
	readonly serviceMonths: number;
	readonly employmentId: string;
	readonly asOf: IsoDate;
}): number {
	const entitlement = options.leaveType.entitlement;
	if (entitlement == null) return 0;
	const forLevel = (level: 'STATUTORY' | 'ORGANISATION' | 'EMPLOYEE'): number | null => {
		let best: { floor: number; days: number } | null = null;
		for (const layer of entitlement.layers) {
			if (layer.level !== level) continue;
			if (layer.level === 'EMPLOYEE' && layer.employment_id !== options.employmentId) continue;
			if (!coversDate(layer.effective_range, options.asOf)) continue;
			const floor = layer.key.by === 'FLAT' ? 0 : layer.key.band_from;
			if (floor > options.serviceMonths) continue;
			if (best == null || floor > best.floor) best = { floor, days: Number(layer.days) };
		}
		return best?.days ?? null;
	};
	const statutory = forLevel('STATUTORY') ?? 0;
	const organisation = forLevel('ORGANISATION') ?? statutory;
	const employee = forLevel('EMPLOYEE') ?? organisation;
	return Math.max(statutory, organisation, employee);
}

/**
 * Days accrued between the leave-year start and a date.
 *
 * The band is read **at each month**, so someone crossing a service band in July accrues at the old
 * rate for the first half of the year and the new one for the second — and a mid-year joiner is
 * prorated for free, which is why there is no `prorate_on_hire` flag. A partial first or last month
 * counts pro rata by calendar days.
 */
export function accruedDays(options: {
	readonly leaveType: LeaveType;
	readonly entitlementAtMonths: (serviceMonths: number) => number;
	readonly hireDate: IsoDate;
	readonly exitDate: IsoDate | null;
	readonly leaveYearStart: IsoDate;
	readonly asOf: IsoDate;
}): number {
	const accrual = options.leaveType.accrual;
	if (accrual == null)
		throw new Error(`Leave type ${options.leaveType.code} has no accrual and cannot be read.`);
	if (accrual.kind === 'PER_EVENT') return 0;

	const start =
		options.leaveYearStart > options.hireDate ? options.leaveYearStart : options.hireDate;
	const end =
		options.exitDate != null && options.exitDate < options.asOf ? options.exitDate : options.asOf;
	if (end < start) return 0;

	if (accrual.kind === 'UPFRONT') {
		// The whole entitlement exists from the start of the leave year. Upfront means upfront: it is
		// not re-prorated by hire date, which is both the plain meaning and the behaviour of record
		// (decision L8).
		return options.entitlementAtMonths(completedMonths(options.hireDate, end));
	}

	let total = 0;
	for (let month = monthKey(start); month <= monthKey(end); month = shiftPeriod(month, 1)) {
		const monthStart = `${month}-01`;
		const monthLength = monthDays(monthStart);
		const from = monthStart > start ? monthStart : start;
		const lastDay = `${month}-${String(monthLength).padStart(2, '0')}`;
		const to = lastDay < end ? lastDay : end;
		if (to < from) continue;
		const coveredDays = Number(to.slice(8, 10)) - Number(from.slice(8, 10)) + 1;
		const entitlement = options.entitlementAtMonths(completedMonths(options.hireDate, to));
		total += (entitlement / 12) * (coveredDays / monthLength);
	}
	return roundHalfDay(total);
}

/** Days moved by the ledger inside a window. */
export function ledgerDays(
	rows: readonly LedgerRow[],
	leaveTypeId: string,
	window: { readonly start: IsoDate; readonly end: IsoDate },
	basis: BalanceBasis
): number {
	return rows.reduce((total, row) => {
		if (row.leave_type_id !== leaveTypeId || !visible(row, basis)) return total;
		const date = dateKey(row.entry_date);
		if (date == null || date < window.start || date > window.end) return total;
		return total + Number(row.days);
	}, 0);
}

type BalanceInput = {
	readonly leaveType: LeaveType;
	readonly entitlementAtMonths: (serviceMonths: number) => number;
	readonly hireDate: IsoDate;
	readonly exitDate: IsoDate | null;
	readonly leaveYearStartMonth: number;
	readonly ledger: readonly LedgerRow[];
	readonly basis: BalanceBasis;
};

function yearWindow(year: number, startMonth: number): { start: IsoDate; end: IsoDate } {
	const month = String(Math.min(12, Math.max(1, Math.trunc(startMonth)))).padStart(2, '0');
	const start = `${year}-${month}-01`;
	const nextStart = `${year + 1}-${month}-01`;
	const end = new Date(Date.parse(`${nextStart}T00:00:00.000Z`) - 86_400_000)
		.toISOString()
		.slice(0, 10);
	return { start, end };
}

/**
 * Days carried into a leave year: last year's closing balance, capped by the carry limit.
 *
 * Recursion terminates at the hire year, where nothing is carried in. A ten-year employee is ten
 * levels of the same arithmetic — about 120 band lookups and one ledger scan — which is cheap
 * enough to run on every page load, which is why nothing needs caching.
 */
export function carriedInDays(input: BalanceInput, year: number): number {
	const hireYear = leaveYearOf(input.hireDate, input.leaveYearStartMonth);
	if (year <= hireYear) return 0;
	const accrual = input.leaveType.accrual;
	if (accrual == null || accrual.kind === 'PER_EVENT') return 0;
	const carry = accrual.carry;
	if (carry == null) return 0;
	const previous = yearWindow(year - 1, input.leaveYearStartMonth);
	// A carry-forward is settled days only: an unapproved request must not be able to consume next
	// year's balance permanently (decision L7).
	const closing =
		carriedInDays(input, year - 1) +
		accruedDays({
			leaveType: input.leaveType,
			entitlementAtMonths: input.entitlementAtMonths,
			hireDate: input.hireDate,
			exitDate: input.exitDate,
			leaveYearStart: previous.start,
			asOf: previous.end
		}) -
		expiredDays(input, year - 1) +
		ledgerDays(input.ledger, input.leaveType.norbital_id, previous, 'SETTLED');
	return Math.max(0, Math.min(closing, carry.limit_days));
}

/**
 * Carried-in days that lapsed unused.
 *
 * Consumption is oldest-first — leave taken is charged against carried-in days before this year's
 * accrual — so only what the carry-in still holds on the expiry date is lost. Without oldest-first
 * this would remove days already spent, and the balance would be wrong by exactly what was taken
 * before the deadline.
 */
export function expiredDays(input: BalanceInput, year: number, asOf?: IsoDate): number {
	const accrual = input.leaveType.accrual;
	if (accrual == null || accrual.kind === 'PER_EVENT') return 0;
	const carry = accrual.carry;
	if (carry == null || carry.expiry_months <= 0) return 0;
	const window = yearWindow(year, input.leaveYearStartMonth);
	const expiryDate = `${shiftPeriod(monthKey(window.start), carry.expiry_months)}-01`;
	const measuredAt = asOf ?? window.end;
	if (measuredAt < expiryDate) return 0;
	const carriedIn = carriedInDays(input, year);
	const takenBefore = -Math.min(
		0,
		ledgerDays(
			input.ledger,
			input.leaveType.norbital_id,
			{ start: window.start, end: expiryDate },
			'SETTLED'
		)
	);
	return Math.max(0, carriedIn - takenBefore);
}

/** The full five-step balance on a date. */
export function leaveBalance(input: BalanceInput, asOf: IsoDate): number {
	const year = leaveYearOf(asOf, input.leaveYearStartMonth);
	const window = yearWindow(year, input.leaveYearStartMonth);
	return (
		carriedInDays(input, year) +
		accruedDays({
			leaveType: input.leaveType,
			entitlementAtMonths: input.entitlementAtMonths,
			hireDate: input.hireDate,
			exitDate: input.exitDate,
			leaveYearStart: window.start,
			asOf
		}) -
		expiredDays(input, year, asOf) +
		ledgerDays(
			input.ledger,
			input.leaveType.norbital_id,
			{ start: window.start, end: asOf },
			input.basis
		)
	);
}

/** Unpaid leave taken inside the attendance window, grouped by the component that carries it. */
export type UnpaidLeave = {
	readonly componentId: string;
	readonly days: number;
	readonly leaveRequestIds: readonly string[];
};

/** Every unpaid day this employment has ever taken, in order — the input to a spell. */
export function unpaidLeaveDates(
	ledger: readonly LedgerRow[],
	leaveTypes: Configuration['leaveTypes']
): IsoDate[] {
	const unpaidTypeIds = new Set(
		leaveTypes.filter((type) => type.payroll_effect?.kind === 'UNPAID').map((t) => t.norbital_id)
	);
	const dates: IsoDate[] = [];
	for (const row of ledger) {
		if (row.kind !== 'TAKEN' || row.norbital_approval_id != null) continue;
		if (!unpaidTypeIds.has(row.leave_type_id)) continue;
		const date = dateKey(row.entry_date);
		if (date != null) dates.push(date);
	}
	return dates.toSorted();
}

/**
 * The only thing payroll reads from leave.
 *
 * `leave_types.payroll_effect` names the deduction component that carries the lost wage. A paid
 * type moves the ledger and costs nothing; an unpaid one costs a day's wage per day, whatever the
 * balance says.
 *
 * **Which run pays for a day is a cutoff question, and it has two answers.** An ordinary unpaid day
 * settles in the run whose attendance window contains it — that is the pay calendar, and it lags by
 * up to a month. A day inside a *leave of absence* settles in the run for its own calendar month,
 * because a leave that begins on the 15th is felt in that month's pay rather than the next one's.
 * `extendedDates` is the set of days the second answer applies to, resolved by the caller from
 * `companies.settlement_policy`; passing an empty set is the plain calendar.
 *
 * The two selections are disjoint — a day is in `extendedDates` or it is not — so across the run
 * sequence every unpaid day is deducted exactly once. That is the invariant, and it is the reason
 * this is one predicate here rather than an adjustment somewhere later.
 */
export function unpaidLeaveInWindow(options: {
	readonly ledger: readonly LedgerRow[];
	readonly window: { readonly start: IsoDate; readonly end: IsoDate };
	readonly configuration: Pick<Configuration, 'leaveTypes'>;
	/** The calendar month this run pays for — where an extended absence's days settle. */
	readonly month?: { readonly start: IsoDate; readonly end: IsoDate };
	/** Days belonging to an extended absence, from `extendedAbsenceDays`. */
	readonly extendedDates?: ReadonlySet<IsoDate>;
}): UnpaidLeave[] {
	const typeById = new Map(
		options.configuration.leaveTypes.map((type) => [type.norbital_id, type])
	);
	const extended = options.extendedDates ?? new Set<IsoDate>();
	const month = options.month;
	const byComponent = new Map<string, { days: number; requests: Set<string> }>();
	for (const row of options.ledger) {
		if (row.kind !== 'TAKEN' || row.norbital_approval_id != null) continue;
		const date = dateKey(row.entry_date);
		if (date == null) continue;
		const settlesHere =
			extended.has(date) && month != null
				? date >= month.start && date <= month.end
				: date >= options.window.start && date <= options.window.end;
		if (!settlesHere) continue;
		const type = typeById.get(row.leave_type_id);
		if (!type) continue;
		const effect = type.payroll_effect;
		if (effect == null || effect.kind !== 'UNPAID') continue;
		const bucket = byComponent.get(effect.component_id) ?? { days: 0, requests: new Set<string>() };
		// A TAKEN row is negative; the deduction it causes is a magnitude.
		bucket.days += Math.abs(Number(row.days));
		if (row.source_id != null) bucket.requests.add(row.source_id);
		byComponent.set(effect.component_id, bucket);
	}
	return [...byComponent].map(([componentId, bucket]) => ({
		componentId,
		days: bucket.days,
		leaveRequestIds: [...bucket.requests]
	}));
}
