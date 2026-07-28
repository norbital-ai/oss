import { date, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		work_date: date().notNull(),
		shift_definition_id: uuid().notNull(),
		/**
		 * The roster code shown to the operator in the source schedule. On a non-working day this
		 * is the REST/OFF code (for example AMRES), while shift_definition_id still points to the
		 * employee's underlying working shift so worked hours can be measured correctly.
		 */
		assignment_code: text(),
		/**
		 * What the roster says the day IS, which is not the same as which shift is attached to it.
		 *
		 * `OFF` is a third kind, not a synonym for `REST`: a rostered non-working day that is
		 * nonetheless worked has no scheduled shift to run past, so every clocked hour is overtime
		 * — but at the ORDINARY multiplier, because an off day is neither a rest day nor a public
		 * holiday. Collapsing it into either one misprices every hour worked on it.
		 */
		designation: enums(['WORK', 'REST', 'OFF']).notNull()
	},
	{
		description:
			'Which shift one person is scheduled to work on one day, the source-facing assignment code, and whether that day is a working, rest or off day. Optional — office staff on a fixed week have none.',
		recordLabel: 'work_date',
		icon: 'lucide:calendar-days',
		indexes: [{ columns: ['employment_id', 'work_date'], unique: true }]
	}
);
