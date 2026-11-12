import type { Json } from '@norbital-ai/std/wire';
import { input_schema, type Kind, type Value } from '@norbital-ai/std/kind';
import { Result, Schema } from 'effect';
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
/** Decode with the captured definition; unavailable custom renderers or malformed values display the captured JSON. */
export function historicalValue(kind: Kind | undefined, value: Json): { kind: Kind; value: Value } {
	if (kind === undefined || kind.kind === 'custom') return { kind: { kind: 'json' }, value };
	const decoded = Schema.decodeUnknownResult(input_schema(kind))(value);
	return Result.isSuccess(decoded)
		? { kind, value: decoded.success }
		: { kind: { kind: 'json' }, value };
}
/** One revision on the record header's timeline: when, by whom (`kind:id` split) and which visible fields it changed. */
export type Checkpoint = {
	revision: number;
	at: string | null;
	actor: { kind: string; id: string } | null;
	fields: readonly string[];
	/** Why the revision was written, when not by a direct write (a cascade, derivation, seed, erasure or restore). */
	cause?: Exclude<HistoryEntry['cause'], 'direct'>;
	/** A per-record restore's source revision; `null` for any other write. */
	restored_from: number | null;
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
			...(entry.cause === 'direct' ? {} : { cause: entry.cause }),
			restored_from: entry.restored_from,
			approval: entry.approval,
			valid: entry.valid,
			fields: Object.entries(entry.changed)
				.filter(([field]) => !BOOKKEEPING.has(field))
				.map(([field]) => field)
		}))
		.sort((a, b) => a.revision - b.revision);
}
/** Why a restore (a record's, or a rejected approval's rollback) left a field as it is, in words. */
export function skipText(bolt: Pick<ViewBolt, 't'>, reason: string): string {
	switch (reason) {
		case 'deleted_target':
			return msg(bolt, 'record.restoreSkip.deleted_target');
		case 'read_only':
			return msg(bolt, 'record.restoreSkip.readOnly');
		case 'no_grant':
			return msg(bolt, 'record.restoreSkip.no_grant');
		case 'state_locked':
			return msg(bolt, 'record.restoreSkip.state_locked');
		case 'definition_changed':
		case 'incompatible':
			return msg(bolt, 'record.restoreSkip.incompatible');
		default:
			return humanize(reason);
	}
}
