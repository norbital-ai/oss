import { custom, dateRange, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		job_title: text({ search: true }).notNull(),
		job_number: text(),
		project_id: uuid(),
		job_type: text(),
		status: enums(['planned', 'ready', 'in_progress', 'completed', 'blocked', 'cancelled']),
		schedule_range: dateRange(),
		budget: custom('money'),
		bim_reference_id: uuid(),
		site_location_id: uuid(),
		description: text(),
		priority: enums(['low', 'medium', 'high', 'critical'])
	},
	{
		description: 'Project work packages configured by site location and BIM reference context.',
		recordLabel: 'job_title',
		icon: 'lucide:briefcase-business',
		indexes: [{ columns: ['job_number'], unique: true }]
	}
);
