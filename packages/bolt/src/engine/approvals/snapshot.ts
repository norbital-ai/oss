import { Schema } from 'effect';
import { StoredReadGuards } from './read-guards.ts';

const Step = Schema.Struct({
	name: Schema.String,
	teams: Schema.Array(Schema.String),
	users: Schema.Array(Schema.String)
});
/**
 * The flow a request stores (`bolt_approvals.route`): the `steps` arm of `ApprovalSnapshot`, with each step's name,
 * team handles and `sys_user` ids, so a later release cannot restate it.
 */
export const Snapshot = Schema.Struct({
	kind: Schema.Literal('steps'),
	steps: Schema.Array(Step).check(Schema.isMinLength(1)),
	superseded_by: Schema.Array(Schema.String)
});
export type Snapshot = typeof Snapshot.Type;

/** Only the native database route decoder accepts stored read plans; authored flow decoding uses Snapshot above. */
export const StoredSnapshot = Schema.Struct({
	...Snapshot.fields,
	__boltReadGuards: Schema.optionalKey(StoredReadGuards)
});
export type StoredSnapshot = typeof StoredSnapshot.Type;
