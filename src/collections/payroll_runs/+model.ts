import { custom, date, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		company_id: uuid().notNull(),
		period: text().notNull(),
		lifecycle: enums(['DRAFT', 'PAID']).notNull(),
		configuration_hash: text().notNull(),
		configuration_snapshot: custom('payroll_configuration_snapshot').notNull(),
		pay_date: date().notNull(),
		attendance_from: date().notNull(),
		attendance_to: date().notNull()
	},
	{
		description:
			'One payroll for one company and one 2026 period. A DRAFT run can be recalculated; a PAID run is immutable and later corrections use adjustment entries.',
		recordLabel: ['period', 'lifecycle'],
		icon: 'lucide:play-circle',
		indexes: [{ columns: ['company_id', 'period'], unique: true }]
	}
);
