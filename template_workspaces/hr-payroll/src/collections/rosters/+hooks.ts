import { workPatternVariantSchema } from '../../custom-types/work_pattern_variant/+definition.js';
import { monthBounds } from '../../lib/period.js';
import {
	validateRosterSchedule,
	type Designation,
	type ValidationDay,
	type ValidationShift
} from './lib/workforce-validation.js';
import type { HookApi, Hooks } from './$types.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Weeks straddle month boundaries, so a published month is judged with its neighbours attached. */
const PADDING_DAYS = 7;
const ENTRY_LIMIT = 20_000;

function addDays(date: string, days: number): string {
	const parsed = Date.parse(`${date}T00:00:00.000Z`);
	return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function dateKey(value: string | Date): string {
	return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/** A generated enum column widens to `string | null`, and an unknown designation is a data fault. */
function designationOf(value: string | null, workDate: string): Designation {
	if (value === 'WORK' || value === 'REST' || value === 'OFF') return value;
	throw new Error(
		`The roster entry on ${workDate} has designation "${value ?? 'null'}", which is not one of ` +
			'WORK, REST or OFF. The month cannot be judged until it says what that day is.'
	);
}

/**
 * Read the month plus its padding and judge it.
 *
 * The padding matters: without the days either side, the first and last weeks of every month look
 * like rest-day shortfalls simply because their remaining days belong to the adjacent roster.
 */
async function assertPublishable(
	api: HookApi,
	roster: { readonly norbital_id: string; readonly month: string; readonly work_pattern_id: string }
): Promise<void> {
	const pattern = await api.db.query.work_patterns.findFirst({
		where: { norbital_id: { eq: roster.work_pattern_id } }
	});
	if (pattern == null) {
		throw new Error('The work pattern this roster belongs to no longer exists.');
	}
	const variant = workPatternVariantSchema.parse(pattern.variant);

	const bounds = monthBounds(roster.month);
	const entries = await api.db.query.roster_entries.findMany({
		where: {
			roster_id: { eq: roster.norbital_id },
			work_date: {
				gte: addDays(bounds.start, -PADDING_DAYS),
				lte: addDays(bounds.end, PADDING_DAYS)
			}
		},
		limit: ENTRY_LIMIT
	});
	if (entries.length === 0) {
		throw new Error(
			`Roster ${roster.month} has no entries, so there is nothing to publish. Assign the month ` +
				'first.'
		);
	}
	if (entries.length === ENTRY_LIMIT) {
		throw new Error(
			`Roster ${roster.month} has at least ${ENTRY_LIMIT} entries, which is more than this check ` +
				'can read in one page. Publishing would validate only part of the month.'
		);
	}

	const shiftIds = [
		...new Set(entries.map((entry) => entry.shift_definition_id).filter((id) => id != null))
	];
	const shifts = await api.db.query.shift_definitions.findMany({
		where: { norbital_id: { in: shiftIds } },
		limit: ENTRY_LIMIT
	});
	const shiftById = new Map<string, ValidationShift>(
		shifts.map((shift) => [
			shift.norbital_id,
			{
				code: shift.code,
				start_time: shift.start_time,
				end_time: shift.end_time,
				break_minutes: Number(shift.break_minutes)
			}
		])
	);

	const days: ValidationDay[] = entries.map((entry) => {
		const workDate = dateKey(entry.work_date);
		return {
			employment_id: entry.employment_id,
			work_date: workDate,
			designation: designationOf(entry.designation, workDate),
			// A rest or off day names no shift; a working day that names none is a violation the
			// validator reports as WORK_DAY_WITHOUT_SHIFT rather than something to guess around here.
			shift:
				entry.shift_definition_id == null
					? null
					: (shiftById.get(entry.shift_definition_id) ?? null)
		};
	});

	const violations = validateRosterSchedule({
		days,
		limits: {
			week_starts_on: variant.week_starts_on,
			min_rest_days_per_week: Number(pattern.min_rest_days_per_week),
			max_consecutive_work_days:
				pattern.max_consecutive_work_days == null
					? null
					: Number(pattern.max_consecutive_work_days),
			max_daily_work_minutes:
				pattern.max_daily_work_minutes == null ? null : Number(pattern.max_daily_work_minutes),
			min_minutes_between_shifts:
				pattern.min_minutes_between_shifts == null
					? null
					: Number(pattern.min_minutes_between_shifts)
		}
	});
	if (violations.length === 0) return;

	// Employee numbers, not employment UUIDs: the person fixing the roster needs to know who.
	const employmentIds = [...new Set(violations.map((violation) => violation.employment_id))];
	const employments = await api.db.query.employments.findMany({
		where: { norbital_id: { in: employmentIds } },
		columns: { norbital_id: true, employee_number: true },
		limit: ENTRY_LIMIT
	});
	const numberById = new Map(
		employments.map((employment) => [employment.norbital_id, employment.employee_number])
	);
	const shown = violations.slice(0, 20);
	const lines = shown.map(
		(violation) =>
			`• ${numberById.get(violation.employment_id) ?? violation.employment_id}: ${violation.message}`
	);
	const remainder =
		violations.length > shown.length ? `\n…and ${violations.length - shown.length} more.` : '';
	throw new Error(
		`Roster ${roster.month} cannot be published because it breaks ${violations.length} ` +
			`scheduling rule(s):\n${lines.join('\n')}${remainder}`
	);
}

export default {
	create: {
		before: {
			description:
				'Requires the roster month to be written YYYY-MM and its work pattern to belong to the same company, and refuses a roster created already published before any day has been assigned.',
			handler: async ({ input, api }) => {
				if (!MONTH_PATTERN.test(input.month)) {
					throw new Error(`Roster month must be written YYYY-MM, not "${input.month}".`);
				}
				const pattern = await api.db.query.work_patterns.findFirst({
					where: {
						norbital_id: { eq: input.work_pattern_id },
						company_id: { eq: input.company_id }
					}
				});
				if (pattern == null) {
					throw new Error(
						"That work pattern does not belong to this company, so it cannot own the company's roster."
					);
				}
				if (input.published_at != null) {
					throw new Error(
						'A roster is created as a draft and published once its entries exist. Create it first, ' +
							'assign the month, then publish.'
					);
				}
				return input;
			}
		}
	},
	update: {
		before: {
			description:
				'Pins a roster to the month and work pattern it was drafted for, and on publication checks every rostered day against the pattern’s rest-day, consecutive-day, daily-hours and inter-shift-gap limits.',
			handler: async ({ input, existing, api }) => {
				if (input.month != null && input.month !== existing.month) {
					throw new Error(
						'A roster month cannot be moved; its entries are dated. Create the other month instead.'
					);
				}
				if (input.work_pattern_id != null && input.work_pattern_id !== existing.work_pattern_id) {
					throw new Error(
						'A roster belongs to the pattern it was drafted for. Create a roster for the other ' +
							'pattern instead.'
					);
				}
				const publishing = input.published_at != null && existing.published_at == null;
				if (publishing) await assertPublishable(api, existing);
				return input;
			}
		}
	},
	delete: {
		before: {
			description:
				'Refuses to delete a published roster, because the payroll engine reads it to price the month; the month must be re-opened first.',
			handler: async ({ existing }) => {
				if (existing.published_at != null) {
					throw new Error(
						`Roster ${existing.month} is published and the payroll engine reads it. Re-open it ` +
							'before deleting, so the change is deliberate.'
					);
				}
			}
		}
	}
} satisfies Hooks;
