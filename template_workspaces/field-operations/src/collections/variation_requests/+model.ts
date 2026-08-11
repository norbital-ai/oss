import { custom, defineModel, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		job_assignment_id: uuid().notNull(),
		requested_at: timestamp().notNull(),
		title: text({ search: true }).notNull(),
		description: text().notNull(),
		amount: custom('money'),
		source_message_id: text()
	},
	{
		description:
			'On-site variation order: a request to change the approved scope. Creation is governed by the platform access-control policy; provisional state, approval, rejection, rollback, and audit history live only in the native approval system.',
		recordLabel: 'title',
		icon: 'lucide:git-pull-request-arrow',
		indexes: [{ columns: ['source_message_id'], unique: true }]
	}
);
