import { defineModel, enums, file, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		title: text().notNull(),
		rfi_number: text(),
		project_id: uuid(),
		asked_by: text(),
		assigned_to: text(),
		subject: text(),
		question: text(),
		answer: text(),
		status: enums(['open', 'answered', 'closed']),
		priority: enums(['low', 'medium', 'high', 'critical']),
		submitted_date: timestamp(),
		due_date: timestamp(),
		resolved_date: timestamp(),
		attachments: file().array(),
		related_defect_id: uuid()
	},
	{
		description: 'Design and coordination questions raised during delivery.',
		recordLabel: ['rfi_number', 'title'],
		icon: 'lucide:messages-square',
		indexes: [{ columns: ['rfi_number'], unique: true }]
	}
);
