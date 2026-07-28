import { defineModel, enums, file, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		title: text().notNull(),
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
		reported_date: timestamp(),
		due_date: timestamp(),
		closed_date: timestamp(),
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
