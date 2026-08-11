import { date, defineModel, enums, file, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		title: text({ search: true }).notNull(),
		defect_number: text(),
		project_id: uuid(),
		site_location_id: uuid(),
		job_id: uuid(),
		reported_by: text(),
		assigned_to: text(),
		category: text(),
		severity: enums(['low', 'medium', 'high', 'critical']),
		status: enums(['open', 'in_review', 'ready_for_closeout', 'closed']),
		description: text(),
		reported_date: date(),
		due_date: date(),
		closed_date: date(),
		photos: file({ mimeTypes: ['image/jpeg', 'image/png'] }).array(),
		resolution_notes: text()
	},
	{
		description: 'Quality issues and closeout items tracked in project context.',
		recordLabel: 'title',
		icon: 'lucide:triangle-alert',
		indexes: [{ columns: ['defect_number'], unique: true }]
	}
);
