import { Schema } from 'effect';
import type { RecordCapabilities, RestorePreview } from '@norbital-ai/ui';

export type {
	RecordCapabilities,
	RecordRestriction,
	RecordParentContext,
	RestorePreview,
	RestoreSkip
} from '@norbital-ai/ui';
const Reason = Schema.Literals([
	'noGrant',
	'stateLocked',
	'syncOwned',
	'ownedParent',
	'ownedParentLocked',
	'underApproval'
]);
const Operation = Schema.Struct({
	allowed: Schema.Boolean,
	proposal: Schema.Boolean,
	reasons: Schema.Array(Reason)
});
/** Current-row advice only; write admission still checks post-images, write callbacks and database constraints. */
export const RecordCapabilitiesSchema: Schema.Codec<RecordCapabilities> = Schema.Struct({
	model: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	revision: Schema.Int,
	fields: Schema.Record(
		Schema.String,
		Schema.Struct({
			writable: Schema.Boolean,
			proposal: Schema.Boolean,
			reasons: Schema.Array(Reason)
		})
	),
	update: Operation,
	delete: Operation,
	moves: Schema.Record(Schema.String, Schema.Array(Schema.String)),
	proposalMoves: Schema.Record(Schema.String, Schema.Array(Schema.String))
});
const Change = { field: Schema.String, current: Schema.Json, restored: Schema.Json };
/** `history.preview`'s answer (rule 17): advice for one restore; `history.restore` recomputes it before writing. */
export const RestorePreviewSchema: Schema.Codec<RestorePreview> = Schema.Struct({
	model: Schema.String,
	record: Schema.String,
	revision: Schema.Int,
	live: Schema.Int,
	changes: Schema.Array(Schema.Struct({ ...Change, approval: Schema.Boolean })),
	skipped: Schema.Array(
		Schema.Struct({
			...Change,
			reason: Schema.Literals([
				'deletedTarget',
				'readOnly',
				'noGrant',
				'stateLocked',
				'masked',
				'definitionChanged'
			])
		})
	)
});
