import { boolean, defineModel, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		account_id: uuid().notNull(),
		first_name: text({ search: true }).notNull(),
		last_name: text({ search: true }).notNull(),
		email: text(),
		title: text(),
		department: text(),
		active: boolean().notNull()
	},
	{
		description: 'People at accounts. Decision-makers, buyers, and day-to-day contacts.',
		recordLabel: ['first_name', 'last_name'],
		icon: 'lucide:contact-round',
		indexes: [{ columns: ['account_id'] }]
	}
);
