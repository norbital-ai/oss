import { assertNoOverlap } from '../../lib/effective_range.js';
import { workPatternVariantSchema } from '../../custom-types/work_pattern_variant/+definition.js';
import type { HookApi, Hooks, Row } from './$types.js';

/**
 * A pattern that contradicts itself misprices every day it governs, so the contradictions are
 * refused at the write rather than discovered in a payslip.
 *
 * The rest/off distinction is the one that costs money: a day named as both is unanswerable, and a
 * week with no rest day at all is unlawful under EA 1955 s.59 as well as unpriceable.
 */
/**
 * An insert payload leaves optional columns `undefined` where a stored row has them `null`, so the
 * candidate accepts both and the checks below read one shape.
 */
type Candidate = Pick<Row, 'company_id'> & {
	/** Parsed rather than trusted, so the variant is validated once, here. */
	readonly variant?: unknown;
	readonly default_shift_definition_id?: string | null;
	readonly min_rest_days_per_week?: number | null;
	readonly max_consecutive_work_days?: number | null;
	readonly max_daily_work_minutes?: number | null;
	readonly min_minutes_between_shifts?: number | null;
};

/** Mirrors the column default, so an insert that omits the promise still gets the statutory floor. */
const DEFAULT_MIN_REST_DAYS_PER_WEEK = 1;

async function assertCoherent(api: HookApi, candidate: Candidate, identity: string): Promise<void> {
	const variant = workPatternVariantSchema.parse(candidate.variant);
	const minRestDays = candidate.min_rest_days_per_week ?? DEFAULT_MIN_REST_DAYS_PER_WEEK;

	if (minRestDays < 1) {
		throw new Error(
			`${identity}: a week must contain at least one rest day (EA 1955 s.59), so ` +
				'min_rest_days_per_week cannot be lowered below one. Raise it to be more generous.'
		);
	}
	for (const [field, value] of [
		['max_consecutive_work_days', candidate.max_consecutive_work_days],
		['max_daily_work_minutes', candidate.max_daily_work_minutes],
		['min_minutes_between_shifts', candidate.min_minutes_between_shifts]
	] as const) {
		if (value != null && value <= 0) {
			throw new Error(`${identity}: ${field} must be greater than zero when it is set at all.`);
		}
	}

	if (variant.type === 'ROSTERED') {
		if (candidate.default_shift_definition_id != null) {
			throw new Error(
				`${identity}: a rostered pattern takes its shift from each roster entry, so it cannot ` +
					'also carry a default shift. Clear the default shift or make the pattern standard.'
			);
		}
		return;
	}

	const overlap = variant.rest_days.filter((day) => variant.off_days.includes(day));
	if (overlap.length > 0) {
		throw new Error(
			`${identity}: ${overlap.join(', ')} is named as both a rest day and an off day. A day is ` +
				'one or the other — work on a rest day earns the rest-day multiple, work on an off day ' +
				'earns the ordinary one.'
		);
	}
	if (new Set(variant.rest_days).size !== variant.rest_days.length) {
		throw new Error(`${identity}: the same weekday is named twice as a rest day.`);
	}
	if (new Set(variant.off_days).size !== variant.off_days.length) {
		throw new Error(`${identity}: the same weekday is named twice as an off day.`);
	}
	if (variant.rest_days.length < minRestDays) {
		throw new Error(
			`${identity}: the week names ${variant.rest_days.length} rest day(s) but the pattern ` +
				`promises at least ${minRestDays}.`
		);
	}
	if (variant.rest_days.length + variant.off_days.length >= 7) {
		throw new Error(
			`${identity}: the week has no working day left once rest and off days are named.`
		);
	}

	if (candidate.default_shift_definition_id == null) {
		throw new Error(
			`${identity}: a standard week works the same shift every ordinary day, so it needs a ` +
				'default shift.'
		);
	}
	const shifts = await api.db.query.shift_definitions.findMany({
		where: {
			norbital_id: { eq: candidate.default_shift_definition_id },
			company_id: { eq: candidate.company_id }
		},
		limit: 1
	});
	if (shifts.length === 0) {
		throw new Error(
			`${identity}: the default shift does not exist for this company. A pattern cannot borrow ` +
				"another company's shift."
		);
	}
}

/** Patterns already governing terms or rosters are frozen; a change becomes a successor row. */
async function referenceCount(api: HookApi, workPatternId: string): Promise<number> {
	const [terms, rosters] = await Promise.all([
		api.db.employment_terms.count({ where: { work_pattern_id: { eq: workPatternId } } }),
		api.db.rosters.count({ where: { work_pattern_id: { eq: workPatternId } } })
	]);
	return terms + rosters;
}

export default {
	create: {
		before: {
			description:
				'Refuses a self-contradicting week — a day named as both rest and off, fewer rest days than the pattern promises, no working day left, or a standard week without a valid default shift — and refuses a pattern whose effective range overlaps another with the same code.',
			handler: async ({ input, api }) => {
				await assertCoherent(api, input, `work pattern ${input.code}`);
				const siblings = await api.db.query.work_patterns.findMany({
					where: { company_id: { eq: input.company_id }, code: { eq: input.code } }
				});
				assertNoOverlap({
					candidate: input.effective_range,
					existing: siblings,
					identity: `work pattern ${input.code}`
				});
				return input;
			}
		}
	},
	update: {
		before: {
			description:
				'Freezes a work pattern once it governs employment terms or a roster, because editing it would silently reprice days already worked; an untouched pattern is re-checked for a coherent week and a non-overlapping effective range.',
			handler: async ({ input, existing, api }) => {
				if ((await referenceCount(api, existing.norbital_id)) > 0) {
					throw new Error(
						`Work pattern ${existing.code} already governs employment terms or a roster, so ` +
							'changing it would silently reprice days that have already been worked. End-date ' +
							'this pattern and create a successor instead.'
					);
				}
				const code = input.code ?? existing.code;
				const merged = { ...existing, ...input };
				await assertCoherent(api, merged, `work pattern ${code}`);
				const siblings = await api.db.query.work_patterns.findMany({
					where: { company_id: { eq: merged.company_id }, code: { eq: code } }
				});
				assertNoOverlap({
					candidate: merged.effective_range,
					existing: siblings,
					identity: `work pattern ${code}`,
					excludeId: existing.norbital_id
				});
				return input;
			}
		}
	},
	delete: {
		before: {
			description:
				'Blocks deleting a work pattern that any employment terms or roster still points at, so the days it already priced stay explicable.',
			handler: async ({ existing, api }) => {
				if ((await referenceCount(api, existing.norbital_id)) > 0) {
					throw new Error(
						`Work pattern ${existing.code} still governs employment terms or a roster and cannot ` +
							'be deleted. End-date it instead so the days it already priced stay explicable.'
					);
				}
			}
		}
	}
} satisfies Hooks;
