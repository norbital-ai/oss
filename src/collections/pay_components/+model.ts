import { custom, dateRange, defineModel, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		company_id: uuid().notNull(),
		code: text().notNull(),
		name: text().notNull(),
		component_type_id: uuid().notNull(),
		eligibility: custom('eligibility_rules').notNull(),
		definition: custom('component_definition').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			"The customer's pay catalogue: what a line is called, who is eligible for it and how its amount is obtained. It carries no statutory flag — chargeability is reachable only through component_type_id.",
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
