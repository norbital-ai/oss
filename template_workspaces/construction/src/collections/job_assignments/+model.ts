import { dateRange, defineModel, enums, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		assignment_code: text({ search: true }),
		job_id: uuid(),
		worker_id: uuid(),
		site_location_id: uuid(),
		role: text(),
		assignment_range: dateRange(),
		status: enums(['assigned', 'in_progress', 'completed', 'cancelled']),
		hours_per_day: numeric(),
		required_certifications: text().array()
	},
	{
		description: 'Worker assignments tied to project jobs and site locations.',
		recordLabel: 'assignment_code',
		icon: 'lucide:hard-hat'
	}
);
