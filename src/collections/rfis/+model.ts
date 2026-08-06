import { date, defineModel, enums, file, text, uuid } from '@norbital-ai/pod/authoring';

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
		submitted_date: date(),
		due_date: date(),
		resolved_date: date(),
		attachments: file().array(),
		related_defect_id: uuid()
	},
	{
		description: 'Design and coordination questions raised during delivery.',
		recordLabel: 'title',
		icon: 'lucide:messages-square',
		indexes: [{ columns: ['rfi_number'], unique: true }]
	}
);
