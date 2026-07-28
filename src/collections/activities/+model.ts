import { date, defineModel, enums, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		regarding_type: enums(['accounts', 'quotes', 'projects']).notNull(),
		regarding_id: uuid().notNull(),
		type: enums(['call', 'meeting', 'email', 'task', 'note']),
		subject: text().notNull(),
		description: text(),
		due_date: date(),
		completed_at: timestamp(),
		owner_id: uuid().notNull()
	},
	{
		description:
			'Sales activities — calls, meetings, emails, tasks, and notes — linked to an account, deal, or project.',
		recordLabel: 'subject',
		icon: 'lucide:calendar-check',
		indexes: [
			{ columns: ['regarding_type', 'regarding_id'] },
			{ columns: ['owner_id'] },
			{ columns: ['due_date'] }
		]
	}
);
