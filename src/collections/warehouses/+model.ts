import { boolean, defineModel, phone, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		code: text().notNull(),
		name: text().notNull(),
		address: text(),
		phone: phone(),
		active: boolean().notNull(),
		notes: text()
	},
	{
		description:
			'Physical stock locations. Sales and purchase documents route to a warehouse so stock is counted somewhere specific rather than company-wide only.',
		recordLabel: 'name',
		icon: 'lucide:warehouse',
		indexes: [{ columns: ['code'], unique: true }, { columns: ['active'] }]
	}
);
