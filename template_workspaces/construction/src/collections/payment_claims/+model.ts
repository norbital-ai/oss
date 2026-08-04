import {
	custom,
	date,
	dateRange,
	defineModel,
	enums,
	file,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		claim_number: text().notNull(),
		project_id: uuid(),
		job_id: uuid(),
		claim_type: enums(['progress', 'variation', 'final']),
		status: enums(['draft', 'submitted', 'certified', 'paid', 'rejected']),
		claimed_amount: custom('money'),
		certified_amount: custom('money'),
		claim_period: dateRange(),
		submitted_date: date(),
		paid_date: date(),
		description: text(),
		supporting_documents: file().array()
	},
	{
		description: 'Commercial claim records with readiness and submission state.',
		recordLabel: 'claim_number',
		icon: 'lucide:banknote',
		indexes: [{ columns: ['claim_number'], unique: true }]
	}
);
