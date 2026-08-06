import { date, defineModel, enums, integer, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		work_date: date().notNull(),
		clock_in: timestamp(),
		clock_out: timestamp(),
		/**
		 * The unpaid break, in whole minutes.
		 *
		 * Minutes are the stored unit because they are exact — every break a rota actually uses is a
		 * whole number of them, and the overtime engine, the payroll export and the customer's
		 * time-entries workbook all measure in them. The operator enters and reads hours; that is
		 * presentation, and it never reinterprets what is stored.
		 */
		break_minutes: integer().notNull().default(0),
		state: enums(['OPEN', 'CLOSED']).notNull(),
		/**
		 * The dedicated overtime punch. Some jurisdictions (the whole PH population here) record
		 * overtime as its OWN in/out pair, and time clocked past the shift on the regular punch
		 * earns nothing unless it was separately punched as overtime — so overtime derived from
		 * `clock_in`/`clock_out` alone is a different quantity, not a drift.
		 *
		 * This is a **recorded punch**, not a derived or approved quantity: "when was overtime punched
		 * separately?" is a meaningful question on every attendance row, and "it wasn't" — both null —
		 * is a real answer rather than missing data.
		 */
		overtime_in: timestamp(),
		overtime_out: timestamp()
	},
	{
		description:
			'What was actually clocked on one day, and nothing else. state is the clock (OPEN while running, CLOSED once both stamps exist); the approval stamp accepts the record. overtime_in/overtime_out carry the dedicated overtime punch where a jurisdiction records one. Overtime hours are not stored here — the payroll run derives them from these punches, the statutory day type and the effective employment terms, so the same day can never be recorded as two different durations.',
		recordLabel: ['work_date', 'state'],
		icon: 'lucide:timer',
		indexes: [{ columns: ['employment_id', 'work_date'] }]
	}
);
