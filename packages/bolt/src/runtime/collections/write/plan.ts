/** Shared invariants for the concrete collection write path. */

export const WRITE_DEPTH_LIMIT = 8;

export type WriteAction = 'create' | 'update' | 'delete';

type WriteRecord = Readonly<{
	readonly collection: string;
	readonly recordId: string;
}>;

export const writeRecordKey = (record: WriteRecord): string =>
	`${record.collection.length}:${record.collection}:${record.recordId}`;

/** A refusal raised before COMMIT has written anything. */
class WritePlanningRefusal extends Error {
	readonly _tag = 'Bolt.Collections.WritePlanningRefusal';
	readonly code = 'invalid-node' as const;

	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'WritePlanningRefusal';
	}
}

/** Resolved many-edge used by declarative preparation. */
export type WritableManyRelation = Readonly<{
	readonly name: string;
	readonly parentCollection: string;
	readonly parentColumn: string;
	readonly childCollection: string;
	readonly childColumn: string;
	readonly cascade: boolean;
}>;

/** The one ownership predicate, shared by omission reconciliation and parent-delete cascade. */
export const ownsManyRelation = (
	relation: Pick<WritableManyRelation, 'cascade' | 'parentColumn'>
): boolean => relation.cascade && relation.parentColumn === 'id';
