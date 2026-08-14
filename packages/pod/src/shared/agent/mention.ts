/**
 * One record a composer chip, mention menu, or turn context names.
 *
 * Shared so the picker, the wire form, and the server attach-block all answer "which record?"
 * with one shape — `collection`, `recordId`, `label` — instead of restating it.
 */
export type MentionRecordHit = {
	readonly collection: string;
	readonly recordId: string;
	readonly label: string;
};
