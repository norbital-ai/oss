import { date, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

/**
 * One person-day of the roster, which is the source of truth for what that day IS.
 *
 * A roster entry is a tagged union and `designation` is its tag. There are exactly two arms:
 *
 * - `WORK` — a scheduled working day. It carries `shift_definition_id`, and that shift carries the
 *   day's hours: its start, its end, its unpaid break and whether it runs past midnight.
 * - `REST` / `OFF` — a non-working day of a named kind. It schedules no shift at all, so
 *   `shift_definition_id` is null. `OFF` is a third kind rather than a synonym for `REST`: work on
 *   an off day is priced at the ORDINARY multiplier while work on a rest day earns the rest-day
 *   ladder, and collapsing the two misprices every hour worked (decision E27).
 *
 * There is no `PUBLIC_HOLIDAY` arm. A holiday is a property of the calendar, not of one person's
 * roster: `company_holidays` is overlaid at calculation time, so a newly gazetted day reaches
 * payroll without rewriting a single roster row, and the scheduling board draws it from the same
 * calendar rather than from a stored per-person mark. The import pipeline refuses a `PUBLIC_HOLIDAY`
 * row whose date the calendar does not know, so the two can never disagree.
 *
 * `+hooks.ts` enforces the arms on every write. Rows written before this shape existed may still
 * carry a shift on a non-working day; the engine tolerates them unchanged, and the first edit to
 * such a row has to correct it.
 */
export default defineModel(
	{
		employment_id: uuid().notNull(),
		work_date: date().notNull(),
		/**
		 * The shift this day is worked on, and therefore the day's scheduled hours.
		 *
		 * Null on a `REST` or `OFF` entry, because nothing is scheduled on a day that is not worked.
		 * That does NOT make a worked rest day unmeasurable: hours on a day with no scheduled shift
		 * are measured from the punches themselves, clamped to the employee's ordinary shift start —
		 * which the payroll engine already carries over from the rostered working days of the same
		 * window rather than from a shift pinned to a day nobody was scheduled on.
		 */
		shift_definition_id: uuid(),
		/**
		 * The month this entry was drafted in. Entries belonging to a published roster are frozen,
		 * which is what makes publication mean anything. Optional: entries imported or seeded
		 * directly, without going through a drafted month, carry none.
		 */
		roster_id: uuid(),
		/**
		 * The roster token shown to the operator in the source schedule, for example `AMRES` or
		 * `OFF/S`. Provenance, not meaning: `designation` says what the day is and the shift says how
		 * long it is, so nothing is ever derived from this string.
		 */
		assignment_code: text(),
		/** Which arm of the union this entry is: a worked day, or a non-working day of a named kind. */
		designation: enums(['WORK', 'REST', 'OFF']).notNull()
	},
	{
		description:
			'One person-day of the roster: either a working day and the shift it is worked on, or a non-working rest or off day that schedules no shift. Optional — office staff on a fixed week have none.',
		recordLabel: 'work_date',
		icon: 'lucide:calendar-days',
		indexes: [{ columns: ['employment_id', 'work_date'], unique: true }]
	}
);
