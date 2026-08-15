/**
 * One record a composer chip, mention menu, or turn context names.
 *
 * Shared so the picker, the wire form, and the server attach-block all answer "which record?"
 * with one shape — `collection`, `recordId`, `label` — instead of restating it.
 */
import { z } from 'zod';

export const MentionRecordHitSchema = z.object({
	collection: z.string(),
	recordId: z.string(),
	label: z.string()
});
export type MentionRecordHit = z.infer<typeof MentionRecordHitSchema>;
