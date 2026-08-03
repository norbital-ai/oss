import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * The event carried by a leave request row.
 *
 * TIME_OFF is the ordinary approval-backed request. The other arms preserve the two legitimate
 * non-request movements that used to require `leave_ledger`. Keeping them in the same closed union
 * makes one collection the complete event stream without nullable columns that only apply to one
 * kind of event.
 */
export const leaveEventSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('TIME_OFF'),
		from_date: z.iso.date(),
		to_date: z.iso.date(),
		days: z.number().check(z.positive()),
		half_day_start: z.boolean(),
		half_day_end: z.boolean(),
		reason: z.nullable(z.string()),
		certificate_file: z.nullable(z.uuid())
	}),
	z.strictObject({
		kind: z.literal('BALANCE_ADJUSTMENT'),
		effective_on: z.iso.date(),
		movement_days: z.number(),
		note: z.nullable(z.string()),
		source_id: z.nullable(z.uuid())
	}),
	z.strictObject({
		kind: z.literal('ENCASHMENT'),
		effective_on: z.iso.date(),
		movement_days: z.number(),
		note: z.nullable(z.string()),
		source_id: z.nullable(z.uuid())
	}),
	// Only the migration writes this arm. It preserves an old TAKEN ledger row that cannot be
	// matched to a request instead of silently deleting or inventing request dates for it.
	z.strictObject({
		kind: z.literal('LEGACY_TAKEN'),
		effective_on: z.iso.date(),
		movement_days: z.number(),
		note: z.nullable(z.string()),
		source_id: z.nullable(z.uuid())
	})
]);

export type LeaveEvent = z.infer<typeof leaveEventSchema>;

export default defineCustomType({ name: 'leave_event', schema: leaveEventSchema });
