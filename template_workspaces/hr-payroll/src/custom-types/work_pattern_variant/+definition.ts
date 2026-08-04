import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/** Weekday vocabulary, shared with `employment_terms.rest_day` and the scheduling engine. */
export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

const weekdaySchema = z.enum(WEEKDAYS);

/**
 * How a week is shaped for the people on this pattern.
 *
 * `STANDARD` names its rest and off days outright instead of inferring them from a count. A count
 * cannot say which day is which, and the difference is money: work on a rest day earns the rest-day
 * multiple, work on an off day earns the ordinary one. Naming them also makes them swappable — a
 * crew that rests on Monday and takes Sunday off is expressed directly rather than approximated.
 *
 * `week_starts_on` is the anchor for both the working-day derivation and the weekly rest test, so a
 * roster whose week runs Tuesday to Monday is measured over its own week rather than a calendar one.
 *
 * `ROSTERED` derives nothing. Every day comes from a published roster entry, because an operational
 * crew's days are decided month by month and no weekly rule predicts them.
 *
 * The shift itself is not here. It is a foreign key on `work_patterns`, so it reads as a shift name
 * rather than as a UUID typed into a JSON field.
 */
export const workPatternVariantSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('STANDARD'),
		week_starts_on: weekdaySchema,
		/** At least one, per EA 1955 s.59. Weekdays here are priced as rest days when worked. */
		rest_days: z.array(weekdaySchema).check(z.minLength(1)),
		/** Non-working days that are not rest days. Worked hours here price at the ordinary rate. */
		off_days: z.array(weekdaySchema)
	}),
	z.strictObject({
		type: z.literal('ROSTERED'),
		week_starts_on: weekdaySchema
	})
]);

export type WorkPatternVariant = z.infer<typeof workPatternVariantSchema>;

export default defineCustomType({ name: 'work_pattern_variant', schema: workPatternVariantSchema });
