import { date, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		site_id: uuid().notNull(),
		title: text({ search: true }).notNull(),
		nature: text(),
		scheduled_for: date().notNull(),
		status: enums(['unassigned', 'assigned', 'in_progress', 'completed']),
		description: text().notNull()
	},
	{
		description:
			'A site job for a specific day. Certification requirements are governed through job_certification_requirements.',
		recordLabel: 'title',
		icon: 'lucide:briefcase'
	}
);
