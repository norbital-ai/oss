import { date, defineModel, numeric, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		scope: text().notNull(),
		markup_pct: numeric().notNull(),
		effective_from: date(),
		notes: text()
	},
	{
		description:
			'The markup applied to unit cost to derive the lowest price a seller may quote. One row per scope, so a category or region can override the default without a code change.',
		recordLabel: 'scope',
		icon: 'lucide:percent',
		indexes: [{ columns: ['scope'], unique: true }]
	}
);
