import { boolean, defineModel, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		code: text().notNull(),
		name: text({ search: true }).notNull(),
		category: text(),
		issuing_body: text(),
		description: text(),
		active: boolean().notNull()
	},
	{
		description: 'Shared certification catalogue used by job requirements and contractor holdings.',
		recordLabel: 'name',
		icon: 'lucide:badge-check',
		indexes: [{ columns: ['code'], unique: true }]
	}
);
