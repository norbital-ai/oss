import type { Json } from '@norbital-ai/std/wire';
import { isRow, objectsOf } from '../read/results.js';
import { isMasked } from '../cell/value.js';
import type { ViewBolt } from '../client/contract.js';
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
};
/** `bolt.history`'s answer as checkpoints, oldest first; bookkeeping fields are not changes. Revision 1 is the create. */
export function checkpoints(history: unknown): Checkpoint[] {
	return objectsOf(history)
		.flatMap((row): Checkpoint[] => {
			const revision = row['revision'];
			if (typeof revision !== 'number') return [];
			const actor = row['actor'];
			return [
				{
					revision,
					at: typeof row['at'] === 'string' ? row['at'] : null,
					actor:
						isRow(actor) && typeof actor['kind'] === 'string' && typeof actor['id'] === 'string'
							? { kind: actor['kind'], id: actor['id'] }
							: null,
					restoredFrom: typeof row['restoredFrom'] === 'number' ? row['restoredFrom'] : null,
					approval:
						isRow(row['approval']) && typeof row['approval']['request'] === 'string'
							? {
									request: row['approval']['request'],
									state:
										typeof row['approval']['state'] === 'string' ? row['approval']['state'] : null
								}
							: null,
					fields: Object.entries(isRow(row['changed']) ? row['changed'] : {})
						.filter(([field, value]) => !BOOKKEEPING.has(field) && !isMasked(value))
						.map(([field]) => field)
				}
			];
		})
		.sort((a, b) => a.revision - b.revision);
}
/** A revision's place on a `1..latest` ruler, in percent; one revision sits at the end. */
export const tickAt = (revision: number, latest: number) =>
	latest <= 1 ? 100 : ((revision - 1) / (latest - 1)) * 100;
/** The revision nearest a fraction (0–1) of the ruler. */
export const tickOf = (fraction: number, latest: number) =>
	Math.min(latest, Math.max(1, Math.round(fraction * (latest - 1)) + 1));
/** The revisions drawn as ticks: all of them up to `max`, else every n-th, the first, the last and `keep` (the playhead). */
export function drawnTicks(latest: number, max: number, keep: number | null = null): number[] {
	const step = Math.max(1, Math.ceil(latest / max));
	const out = new Set<number>();
	for (let r = 1; r <= latest; r += step) out.add(r);
	out.add(latest);
	if (keep !== null && keep >= 1 && keep <= latest) out.add(keep);
	return [...out].sort((a, b) => a - b);
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
		case 'masked':
			return msg(bolt, 'record.restoreSkip.masked', 'Hidden from you');
		case 'definitionChanged':
			return msg(
				bolt,
				'record.restoreSkip.definitionChanged',
				'The field has changed since this version'
			);
		default:
			return humanize(reason);
	}
}
