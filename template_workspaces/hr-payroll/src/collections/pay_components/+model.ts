import {
	custom,
	dateRange,
	defineModel,
	integer,
	sql,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		company_id: uuid().notNull(),
		code: text({ search: true }).notNull(),
		name: text({ search: true }).notNull(),
		/**
		 * The component's complete economic type. The discriminated union fixes its settlement direction
		 * and owns every effective-dated statutory decision; there is no component-types lookup table.
		 */
		policy: custom('pay_component_policy').notNull(),
		/** Read-only projection used for grouping and reporting. */
		nature: text().generatedAlwaysAs(sql`policy ->> 'kind'`),
		/** Formula/dependency and deduction-reduction order. */
		sequence: integer().notNull(),
		eligibility: custom('eligibility_rules').notNull(),
		definition: custom('component_definition').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			"The customer's complete pay catalogue: name, strict settlement/statutory policy, eligibility and polymorphic calculation definition in one row.",
		recordLabel: ['code', 'name'],
		icon: 'lucide:receipt',
		// Plan 02 §7: one overtime rule may be mapped by at most one component per company, so a
		// derived overtime line can never be paid twice. Filtered on the source, so the new
		// OVERTIME_EXCESS arm — which carries the same `rule` — is deliberately not covered.
		indexes: [
			{
				name: 'overtime_rule_mapped_once',
				columns: ['company_id', { expr: "(definition->>'rule')" }],
				unique: true,
				where: "definition->>'source' = 'OVERTIME'"
			}
		],
		// Plan 02 §7: company =, code =, effective range &&.
		exclusions: [
			{
				name: 'pay_components_no_overlap',
				elements: [
					{ expr: 'company_id', with: '=' },
					{ expr: 'code', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
