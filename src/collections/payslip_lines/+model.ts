import { defineModel, integer, numeric, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		payslip_id: uuid().notNull(),
		pay_component_id: uuid().notNull(),
		component_type_id: uuid().notNull(),
		amount: numeric().notNull(),
		quantity: numeric(),
		rate: numeric(),
		sequence: integer().notNull()
	},
	{
		description:
			'One typed money line on a payslip — every plane of input arrives here converted to money. component_type_id is denormalised so a payslip renders and a report groups without re-resolving configuration that may since have changed.',
		recordLabel: ['sequence', 'amount'],
		icon: 'lucide:list',
		indexes: [{ columns: ['payslip_id'] }]
	}
);
