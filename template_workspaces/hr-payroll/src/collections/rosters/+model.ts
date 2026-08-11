import { defineModel, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		company_id: uuid().notNull(),
		work_pattern_id: uuid().notNull(),
		/** `YYYY-MM`. A roster is drafted and published one calendar month at a time. */
		month: text({ search: true }).notNull(),
		/**
		 * When the month was published. `null` is a draft: incomplete, unvalidated and freely
		 * editable. Setting it runs the statutory checks and freezes the month's entries, so the
		 * roster the payroll engine reads is one somebody signed off rather than one still in flux.
		 */
		published_at: timestamp()
	},
	{
		description:
			'One month of operational schedule for one company and work pattern. Draft while unpublished; publishing validates the month against the pattern and statute, then freezes its entries.',
		recordLabel: 'month',
		icon: 'lucide:calendar-check',
		indexes: [{ columns: ['company_id', 'work_pattern_id', 'month'], unique: true }]
	}
);
