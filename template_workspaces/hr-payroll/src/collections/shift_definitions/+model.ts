import {
	boolean,
	clockTime,
	dateRange,
	defineModel,
	integer,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		company_id: uuid().notNull(),
		code: text().notNull(),
		name: text().notNull(),
		start_time: clockTime().notNull(),
		end_time: clockTime().notNull(),
		break_minutes: integer().notNull(),
		crosses_midnight: boolean().notNull(),
		/**
		 * Whether this shift can pay overtime at all. A fixed office shift never does, regardless of
		 * clocked hours — without this, office staff start earning overtime for staying late.
		 * Defaults to true because a shift that is rostered and clocked normally does pay it; the
		 * exemption is the thing that has to be stated.
		 */
		pays_overtime: boolean().notNull().default(true),
		/**
		 * Unpaid rest granted between the end of the shift and the start of overtime, deducted from
		 * the overtime hours. Production shifts grant one; office shifts do not. Without it every
		 * production overtime day overstates overtime by exactly this break.
		 */
		overtime_break_minutes: integer().notNull().default(0),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'A named working shift: its clock boundaries, unpaid break and whether it runs past midnight. Rostered against an employment to establish the normal hours overtime is measured beyond.',
		recordLabel: ['code', 'name'],
		icon: 'lucide:clock'
	}
);
