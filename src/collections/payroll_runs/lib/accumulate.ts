/**
 * Step 5 — ACCUMULATE.
 *
 * Every measured line passes through the treatment grid and becomes part of a contribution base.
 * Nothing in this step knows the word "EPF" and nothing knows the word "overtime": a line carries a
 * component type, a type and a contribution meet in exactly one grid cell, and the cell says what
 * to do.
 *
 * ```
 * payslip_line  OT_1_5  288.45
 *       │  pay_components.component_type_id
 *       ▼
 * component_type  OVERTIME  (nature EARNING)
 *       ▼
 * OVERTIME × EPF    EXCLUDE  ──►  EPF base    unchanged
 * OVERTIME × SOCSO  INCLUDE  ──►  SOCSO base  += 288.45
 * ```
 *
 * `REDUCE` is why unpaid leave needs no second mechanism: its line is a positive magnitude typed
 * `UNPAID_ABSENCE`, and the cell subtracts it from every base. `SPECIAL` is why no cell is ever
 * blank — "it's complicated" is a value, and it routes the amount to a named side-channel instead
 * of the ordinary base.
 *
 * `UNSET` cannot reach a run. The grid is generated rather than left sparse precisely so that a
 * missing decision can never be read as `EXCLUDE`, which is the dangerous outcome: an
 * under-contribution nobody notices.
 */

import { lookupTreatment, type Configuration, type ContributionConfig } from './configuration.js';
import type { MeasuredLine } from './measure.js';
import { cents } from './rounding.js';

export type ContributionBase = {
	readonly contribution: ContributionConfig;
	/** Never negative: a base is a quantity of chargeable wages, and there is no negative wage. */
	readonly base: number;
	/** Amounts routed by `SPECIAL` cells, keyed by the rule they named. */
	readonly special: Readonly<Record<string, number>>;
};

export function accumulateBases(options: {
	readonly configuration: Configuration;
	readonly lines: readonly MeasuredLine[];
	readonly employeeNumber: string;
}): ContributionBase[] {
	return options.configuration.contributions.map((contribution) => {
		let base = 0;
		const special: Record<string, number> = {};
		for (const line of options.lines) {
			// Information is not money, so the grid does not apply to it and it carries no cell.
			if (line.componentType.nature === 'INFORMATION') continue;
			const treatment = lookupTreatment(
				options.configuration,
				line.componentType.norbital_id,
				contribution.row.norbital_id
			)?.treatment;
			if (treatment == null)
				throw new Error(
					`No ${contribution.row.code} treatment exists for ${line.componentType.code}. ` +
						'The grid is generated for every pair, so an absent cell is a seeding fault.'
				);
			switch (treatment.kind) {
				case 'INCLUDE':
					base += line.amount;
					break;
				case 'EXCLUDE':
					break;
				case 'REDUCE':
					base -= line.amount;
					break;
				case 'SPECIAL': {
					if (!contribution.row.special_rules.includes(treatment.rule))
						throw new Error(
							`${line.componentType.code} × ${contribution.row.code} routes to special rule ` +
								`"${treatment.rule}", which ${contribution.row.code} does not declare.`
						);
					special[treatment.rule] = (special[treatment.rule] ?? 0) + line.amount;
					break;
				}
				case 'UNSET':
					throw new Error(
						`${line.componentType.code} × ${contribution.row.code} is undecided. ` +
							`${options.employeeNumber} cannot be paid until the grid cell is set.`
					);
			}
		}
		return { contribution, base: cents(Math.max(0, base)), special };
	});
}
