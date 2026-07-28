import { custom, date, defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		pay_component_id: uuid().notNull(),
		amount: numeric().notNull(),
		quantity: numeric(),
		event_date: date().notNull(),
		pay_period: text(),
		/**
		 * Human-readable provenance — where this amount came from in the source the customer
		 * recognises ("Source MLCLM row 30"), free text, never parsed. Distinct from `origin`,
		 * which is the machine-readable reason the entry exists.
		 */
		description: text(),
		origin: custom('entry_origin').notNull()
	},
	{
		description:
			'The only door money enters payroll through. amount is always a magnitude; direction comes from the component type and a reversal is an origin of kind REVERSAL, never a negative number.',
		recordLabel: ['event_date', 'amount'],
		icon: 'lucide:banknote',
		indexes: [{ columns: ['employment_id', 'pay_period'] }, { columns: ['pay_component_id'] }]
	}
);
