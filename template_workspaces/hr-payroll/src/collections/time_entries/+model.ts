import {
	boolean,
	date,
	defineModel,
	enums,
	integer,
	numeric,
	timestamp,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		work_date: date().notNull(),
		clock_in: timestamp(),
		clock_out: timestamp(),
		break_minutes: integer().notNull().default(0),
		state: enums(['OPEN', 'CLOSED']).notNull(),
		/**
		 * Whether a supervisor pre-approved overtime FOR THIS DAY. This is not the row's approval
		 * stamp: that says "this attendance record is accepted", which a day can be while overtime
		 * on it was never authorised. A clock overrun on an unauthorised day earns nothing.
		 *
		 * Null means the population does not track per-day authorisation at all, and the clock rule
		 * decides on its own — distinct from `false`, which is a recorded refusal.
		 */
		overtime_authorized: boolean(),
		/**
		 * The approved Infotech multiplier buckets for this attendance day. These are hours, not
		 * amounts: payroll still values them from the employment's effective salary terms. All five
		 * are null where the population supplies no bucket breakdown; zero is an explicit source
		 * value and is distinct from missing data.
		 *
		 * The boolean above remains the visible approval decision. When supplied, the bucket total
		 * is the approved payable duration; the legacy multiplier labels remain audit evidence, while
		 * payroll prices the hours from the statutory day type and effective employment terms.
		 */
		approved_ot_1x_hours: numeric(),
		approved_ot_15x_hours: numeric(),
		approved_ot_2x_hours: numeric(),
		approved_ot_3x_hours: numeric(),
		approved_ot_flat_hours: numeric(),
		/**
		 * The dedicated overtime punch. Some jurisdictions (the whole PH population here) record
		 * overtime as its OWN in/out pair, and time clocked past the shift on the regular punch
		 * earns nothing unless it was separately punched as overtime — so overtime derived from
		 * `clock_in`/`clock_out` alone is a different quantity, not a drift.
		 *
		 * Both null where a jurisdiction does not use a separate punch: "when was overtime punched
		 * separately?" is a meaningful question on every attendance row, and "it wasn't" is a real
		 * answer rather than missing data.
		 */
		overtime_in: timestamp(),
		overtime_out: timestamp()
	},
	{
		description:
			'What was actually clocked on one day. state is the clock (OPEN while running, CLOSED once both stamps exist); the approval stamp accepts the record, while overtime_authorized and the approved multiplier buckets state whether and how overtime on it was sanctioned. overtime_in/overtime_out carry the dedicated overtime punch where a jurisdiction records one.',
		recordLabel: ['work_date', 'state'],
		icon: 'lucide:timer',
		indexes: [{ columns: ['employment_id', 'work_date'] }]
	}
);
