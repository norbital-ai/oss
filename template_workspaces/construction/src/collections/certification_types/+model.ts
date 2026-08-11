import { boolean, defineModel, numeric, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		certification_name: text({ search: true }).notNull(),
		certification_code: text(),
		category: text(),
		issuing_body: text(),
		validity_period_months: numeric(),
		requires_refresher: boolean(),
		description: text(),
		requirements: text().array()
	},
	{
		description: 'Certification library used to define workforce requirements.',
		recordLabel: 'certification_name',
		icon: 'lucide:badge-check',
		indexes: [{ columns: ['certification_code'], unique: true }]
	}
);
