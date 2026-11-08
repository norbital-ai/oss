import type { Json } from '@norbital-ai/std/wire';
import type { HistoryEntry, HistorySnapshot, ViewBolt } from '../client/contract.js';
import { humanize, msg } from '../text/messages.js';
/** A related model's records whose history joins the record's: those `where` selects, read through the viewer's scope. */
export type RecordHistorySource = { of: string; where?: Json; fields?: readonly string[] };
/** One record's history plus optional related-record history; no separate event store. */
export type RecordHistoryConfig = {
	fields?: readonly string[];
	sources?: readonly RecordHistorySource[];
};

const BOOKKEEPING = new Set([
	'id',
	'revision',
	'created_at',
	'created_by',
	'updated_at',
	'updated_by'
]);
export const historicalFields = (snapshot: HistorySnapshot) =>
	Object.entries(snapshot.values).filter(([field]) => !BOOKKEEPING.has(field));
/** One revision on the record header's timeline: when, by whom (`kind:id` split) and which visible fields it changed. */
export type Checkpoint = {
	revision: number;
	at: string | null;
	actor: { kind: string; id: string } | null;
	fields: readonly string[];
	/** A per-record restore's source revision; `null` for any other write. */
	restoredFrom: number | null;
	/** The approval request this revision belongs to and that request's state now (`Pending`, `Rejected`, …). */
	approval: { request: string; state: string | null } | null;
	/** Whether the revision still projects into today's representation (its schema and values still fit). */
	valid: boolean;
};
/** `bolt.history`'s answer as checkpoints, oldest first; bookkeeping fields are not changes. Revision 1 is the create. */
export function checkpoints(history: readonly HistoryEntry[]): Checkpoint[] {
	return history
		.map((entry): Checkpoint => ({
			revision: entry.revision,
			at: entry.at,
			actor: entry.actor,
			restoredFrom: entry.restoredFrom,
			approval: entry.approval,
			valid: entry.valid ?? (entry.uncompatible?.length ?? 0) === 0,
			fields: Object.entries(entry.changed)
				.filter(([field]) => !BOOKKEEPING.has(field))
				.map(([field]) => field)
		}))
		.sort((a, b) => a.revision - b.revision);
}
/** Why a restore (a record's, or a rejected approval's rollback) left a field as it is, in words. */
export function skipText(bolt: Pick<ViewBolt, 't'>, reason: string): string {
	switch (reason) {
		case 'deletedTarget':
			return msg(bolt, 'record.restoreSkip.deletedTarget', 'The linked record was deleted');
		case 'readOnly':
			return msg(bolt, 'record.restoreSkip.readOnly', 'Read-only');
		case 'noGrant':
			return msg(bolt, 'record.restoreSkip.noGrant', 'You may not change this field');
		case 'stateLocked':
			return msg(bolt, 'record.restoreSkip.stateLocked', 'This state change is not allowed');
		case 'definitionChanged':
		case 'uncompatible':
			return msg(bolt, 'record.restoreSkip.uncompatible', 'uncompatible');
		default:
			return humanize(reason);
	}
}
