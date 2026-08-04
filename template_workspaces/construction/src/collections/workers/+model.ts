import { custom, date, defineModel, enums, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		worker_name: text().notNull(),
		worker_number: text(),
		trade: text(),
		status: enums(['active', 'inactive', 'suspended']),
		phone: text(),
		email: text(),
		emergency_contact: custom('emergency_contact'),
		date_of_birth: date(),
		nationality: text(),
		work_permit_expiry: date(),
		medical_check_date: date(),
		safety_induction_date: date()
	},
	{
		description: 'Worker roster used for job assignment and compliance checks.',
		recordLabel: ['worker_number', 'worker_name'],
		icon: 'lucide:users',
		indexes: [{ columns: ['worker_number'], unique: true }]
	}
);
