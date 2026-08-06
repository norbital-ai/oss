/**
 * Statutory rest and meal breaks, read from `rest_break_rules`.
 *
 * The break a jurisdiction states is data in the same sense the overtime ladder is: an
 * effective-dated, cited row, never an engine literal. The figures this replaces were the kind a
 * statute names and a codebase forgets it copied — "thirty minutes after five hours" written into
 * a validation, applied to every country in the workspace, surviving the amendment that changed
 * it. Here the row is the only carrier: Malaysia's s.60A(1)(a) five-hour window, Indonesia's
 * "tidak termasuk jam kerja", the Philippine hour that art.85 ties to meals rather than to elapsed
 * hours, each arrives as the row Core seeds for it.
 *
 * Nothing prices these rows yet. A break is owed on the floor, between punches, and whether one
 * was taken is a question over `time_entries` and `shift_definitions` that payroll does not
 * answer. What this module gives the run is the statute itself, resolved and named, so the figure
 * a screen or a future check quotes is the figure the authority states — and so a run can say
 * which break rules were picked with the rest of its law.
 */

export type RestBreakWhen = 'ALWAYS' | 'CONTINUOUS_ATTENDANCE' | 'OVERTIME';

const APPLIES_WHEN: readonly RestBreakWhen[] = ['ALWAYS', 'CONTINUOUS_ATTENDANCE', 'OVERTIME'];

/**
 * The subset of a `rest_break_rules` row the engine reads.
 *
 * `applies_when` is `string`, not the enum, because that is how an enum column arrives from the
 * database — and a row written under an older definition can legitimately carry a value this build
 * has never heard of. Narrowing happens below, where an unrecognised value is a named fault
 * rather than a silent match on whichever arm happened to be tested first.
 */
export type RestBreakRule = {
	readonly after_consecutive_hours: number | string | null;
	readonly minimum_minutes: number | string;
	readonly counts_as_worked_time: boolean | null;
	readonly applies_when: string | null;
	readonly authority: string;
};

export type ResolvedRestBreakRule = {
	readonly appliesWhen: RestBreakWhen;
	/** Null where the authority ties the break to no consecutive-hours trigger. */
	readonly afterConsecutiveHours: number | null;
	readonly minimumMinutes: number;
	/** Null where the authority does not settle whether the break is paid. */
	readonly countsAsWorkedTime: boolean | null;
	readonly authority: string;
};

/**
 * Resolve the break rules a jurisdiction states, keyed by when they bite.
 *
 * A jurisdiction carries at most one rule of each kind — the collection's exclusion constraint
 * says so — so a second row for the same kind is a seeding fault, not a choice to be made.
 * A kind with no row is simply absent: the statute states no such break, and no default may be
 * inferred from another jurisdiction's row or from memory.
 */
export function resolveRestBreakRules(
	rules: readonly RestBreakRule[]
): ReadonlyMap<RestBreakWhen, ResolvedRestBreakRule> {
	const resolved = new Map<RestBreakWhen, ResolvedRestBreakRule>();
	for (const rule of rules) {
		const appliesWhen = APPLIES_WHEN.find((candidate) => candidate === rule.applies_when);
		if (appliesWhen == null)
			throw new Error(
				`Rest break rule "${rule.authority}" applies "${rule.applies_when ?? 'nothing'}", ` +
					'which is not a kind of break this engine reads.'
			);
		if (resolved.has(appliesWhen))
			throw new Error(
				`More than one ${appliesWhen} rest break rule is effective for this jurisdiction.`
			);
		resolved.set(appliesWhen, {
			appliesWhen,
			afterConsecutiveHours:
				rule.after_consecutive_hours == null ? null : Number(rule.after_consecutive_hours),
			minimumMinutes: Number(rule.minimum_minutes),
			countsAsWorkedTime: rule.counts_as_worked_time,
			authority: rule.authority
		});
	}
	return resolved;
}
