import {
	boolean,
	custom,
	dateRange,
	defineModel,
	enums,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		jurisdiction_id: uuid().notNull(),
		/**
		 * The wage ceiling above which the statutory overtime, rest-day and public-holiday ladder
		 * stops applying.
		 *
		 * Null means the jurisdiction imposes no wage-based restriction at all — coverage is decided
		 * by category alone. Null is a stated fact about the law, not a missing value: the Philippine
		 * Labor Code and Indonesian PP 35/2021 both exempt by role and neither names a wage figure.
		 */
		wage_ceiling: custom('money'),
		/**
		 * Whether wages exactly equal to `wage_ceiling` are still covered — `true` for a statute
		 * written as "exceeds X", `false` for one written as "not less than X". Null when there is no
		 * ceiling for it to qualify.
		 */
		ceiling_is_inclusive: boolean(),
		/**
		 * Which wage figure `wage_ceiling` is measured against. Null when there is no ceiling.
		 *
		 * `STATUTORY_WAGES` means the jurisdiction's own statutory definition of wages, which is
		 * normally wider than basic pay. It is deliberately NOT interchangeable with `BASE_SALARY`:
		 * a rule naming `STATUTORY_WAGES` must not be evaluated against a base-salary column, because
		 * the two select different populations and the difference is a mispricing, not a rounding.
		 */
		wage_basis: enums(['STATUTORY_WAGES', 'BASE_SALARY']),
		/**
		 * Which employment column `exempt_categories` and `excluded_categories` name values from.
		 * The two vocabularies are not 1:1, so the rule has to say which one it speaks.
		 */
		category_basis: enums(['STATUTORY_WORK_CATEGORY', 'WORK_CLASSIFICATION']).notNull(),
		/** Categories the ladder covers whatever the wage — checked after `excluded_categories`. */
		exempt_categories: text().array().notNull(),
		/**
		 * Categories the ladder never covers, whatever the wage. Checked first, because a statute that
		 * disapplies a whole Part to a class of worker outranks any wage test.
		 */
		excluded_categories: text().array().notNull(),
		authority: text().notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'Who the statutory overtime ladder covers in a jurisdiction: the wage ceiling that ends coverage, the wage figure that ceiling is measured against, and the work categories that are covered or excluded whatever the wage.',
		recordLabel: ['category_basis', 'authority'],
		icon: 'lucide:user-check',
		// One coverage test governs a jurisdiction at a time. Unlike `overtime_rules` there is no
		// second dimension to band on: the test decides entitlement to the whole ladder, so two rows
		// effective on the same day would make coverage ambiguous rather than additive.
		exclusions: [
			{
				name: 'overtime_coverage_rules_no_overlap',
				elements: [
					{ expr: 'jurisdiction_id', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
