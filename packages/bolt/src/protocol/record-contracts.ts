import { Schema } from 'effect';
import { FieldSpec } from '@norbital-ai/store';
import type { RecordCapabilities, RestorePreview } from '@norbital-ai/ui';

export type {
	RecordCapabilities,
	RecordRestriction,
	RecordParentContext,
	RestorePreview,
	RestoreSkip
} from '@norbital-ai/ui';
const RowCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Native root-row state shared by query answers and declared row outputs. */
export const RowStateFields = {
	$label: Schema.optionalKey(Schema.NullOr(Schema.String)),
	$sync: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
		status: Schema.Literals(['pending', 'ok', 'failed']), message: Schema.optionalKey(Schema.String)
	}))),
	$approval: Schema.optionalKey(Schema.Struct({
		request_id: Schema.String,
		state: Schema.Literals(['Pending', 'ChangesRequested']),
		step: RowCount,
		steps: Schema.Array(Schema.Struct({ name: Schema.String, teams: Schema.Array(Schema.String), users: Schema.Array(Schema.String) })),
		requested_by: Schema.String
	}))
};
const Reason = Schema.Literals([
	'no_grant',
	'state_locked',
	'sync_owned',
	'owned_parent',
	'owned_parent_locked',
	'under_approval'
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
	proposal_moves: Schema.Record(Schema.String, Schema.Array(Schema.String))
});
const Change = { field: Schema.String, current: Schema.Json, restored: Schema.Json };
/** Historical changes retain their own schema version and wire values, including removed names and changed kinds. */
export const HistoryRevisionSchema = Schema.Struct({
	revision: Schema.Int,
	at: Schema.NullOr(Schema.String),
	actor: Schema.NullOr(Schema.Struct({ kind: Schema.String, id: Schema.String })),
	cause: Schema.Literals(['direct', 'cascade', 'derived', 'seed', 'erased', 'restored']),
	restored_from: Schema.NullOr(Schema.Int),
	approval: Schema.NullOr(Schema.Struct({ request: Schema.String, state: Schema.NullOr(Schema.String) })),
	changed: Schema.Record(Schema.String, Schema.Json),
	schema_version: Schema.String,
	incompatible: Schema.Array(Schema.String),
	valid: Schema.Boolean
});
export const HistorySnapshotSchema = Schema.Struct({
	model: Schema.String,
	record: Schema.String,
	revision: Schema.Int,
	at: Schema.NullOr(Schema.String),
	schema_version: Schema.String,
	fields: Schema.Record(Schema.String, FieldSpec),
	values: Schema.Record(Schema.String, Schema.Json),
	compatible: Schema.Record(Schema.String, Schema.Json),
	incompatible: Schema.Array(Schema.String)
});
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
				'deleted_target',
				'read_only',
				'no_grant',
				'state_locked',
				'definition_changed',
				'incompatible'
			])
		})
	)
});
