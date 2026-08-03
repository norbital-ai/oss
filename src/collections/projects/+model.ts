import { date, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		name: text().notNull(),
		description: text(),
		account_id: uuid().notNull(),
		status: enums(['active', 'completed', 'on_hold', 'cancelled']),
		start_date: date(),
		end_date: date(),
		owner_id: uuid().notNull()
	},
	{
		description:
			'Customer or internal projects. Quotes and activities can reference one, which is how a stream of related deals stays attributable to the engagement that produced it.',
		recordLabel: 'name',
		icon: 'lucide:folder-kanban',
		indexes: [{ columns: ['account_id'] }, { columns: ['owner_id'] }, { columns: ['status'] }]
	}
);
