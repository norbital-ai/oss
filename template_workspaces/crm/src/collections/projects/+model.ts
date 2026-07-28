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
			'R&D projects. Quotes can be linked to projects for material tracking and budget reconciliation.',
		recordLabel: 'name',
		icon: 'lucide:flask-conical',
		indexes: [{ columns: ['account_id'] }, { columns: ['owner_id'] }, { columns: ['status'] }]
	}
);
