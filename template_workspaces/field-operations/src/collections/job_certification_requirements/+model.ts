import { defineModel, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		job_id: uuid().notNull(),
		certification_type_id: uuid().notNull()
	},
	{
		description: 'Certification required before a contractor may be assigned to a job.',
		icon: 'lucide:badge-alert',
		indexes: [{ columns: ['job_id', 'certification_type_id'], unique: true }]
	}
);
