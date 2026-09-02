/** Shared invariants for the concrete collection write path. */

import { Schema } from 'effect';
import type { LinkAndRouteValues } from '@norbital-ai/bolt-protocol';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';

export const WRITE_DEPTH_LIMIT = 8;
/**
 * 10,000, raised from 1,000. RFC/sync-engine.md carries the amendment and the receipt.
 *
 * The ceiling is here to stop an unbounded graph, not to make a bounded one illegal. One payroll
 * period for one company is a single declarative write of ~4,000 rows at 89 employees, and the
 * alternative the old value forced — splitting it into separately committed batches — would leave a
 * half-settled run visible, which is the exact state `payroll_runs/+hooks.ts` was written to prevent.
 */
export const MAX_ORDINARY_MUTATION_CHANGED_ROWS = 10_000;

export type WriteAction = 'create' | 'update' | 'delete';

type WriteRecord = Readonly<{
	readonly collection: string;
	readonly recordId: string;
}>;

export const writeRecordKey = (record: WriteRecord): string =>
	`${record.collection.length}:${record.collection}:${record.recordId}`;

/** Complete write-capture metadata emitted by the canonical effective-plan owner. */
export type DeclaredCaptureFields = Readonly<Record<string, ReadonlyArray<string>>>;

/** A refusal raised before COMMIT has written anything. */
class WritePlanningRefusal extends Error {
	readonly _tag = 'Bolt.Collections.WritePlanningRefusal';
	readonly code = 'invalid-node' as const;

	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'WritePlanningRefusal';
	}
}

/**
 * Resolves the exact row projection retained around a committed mutation from effective-plan
 * metadata. Every current collection must be represented, even when its projection is empty;
 * missing or stale metadata fails planning closed.
 */
export const captureFieldsForWorkspace = (
	definition: WorkspaceDefinition,
	declared: DeclaredCaptureFields
): ReadonlyMap<string, ReadonlySet<string>> => {
	const collectionNames = new Set(definition.collections.map(({ name }) => name));
	for (const collection of Object.keys(declared)) {
		if (!collectionNames.has(collection))
			throw new WritePlanningRefusal(
				`The effective plan contains write-capture metadata for unknown collection ${collection}.`
			);
	}
	const fields = new Map<string, ReadonlySet<string>>();
	for (const collection of definition.collections) {
		const selected = declared[collection.name];
		if (!Object.hasOwn(declared, collection.name) || selected === undefined)
			throw new WritePlanningRefusal(
				`The effective plan omitted write-capture metadata for collection ${collection.name}.`
			);
		fields.set(collection.name, new Set([...selected].toSorted()));
	}
	return fields;
};

const isJson = Schema.is(Schema.Json);

/** Copies only explicitly projected JSON values; undeclared bodies never enter the batch. */
export const projectLinkAndRouteValues = (
	row: Readonly<Record<string, unknown>>,
	fields: ReadonlySet<string>
): LinkAndRouteValues => {
	const projected: Record<string, Schema.Json> = {};
	for (const field of [...fields].toSorted()) {
		const value = row[field];
		if (Object.hasOwn(row, field) && isJson(value)) projected[field] = value;
	}
	return projected;
};

type PlannedRowChange = Readonly<{
	readonly action: WriteAction;
	readonly collection: string;
	readonly id: string;
	readonly values: Readonly<Record<string, unknown>>;
	readonly clearLock?: boolean;
}>;

/** Empty updates without lock release do not execute a row statement and are not captured. */
export const writeOperationChangesRow = (operation: PlannedRowChange): boolean =>
	operation.action !== 'update' ||
	Object.keys(operation.values).length > 0 ||
	operation.clearLock === true;

/** Counts unique rows the prepared ordinary transaction will actually change. */
export const ordinaryMutationChangedRowCount = (
	operations: ReadonlyArray<PlannedRowChange>
): number =>
	new Set(
		operations
			.filter(writeOperationChangesRow)
			.map((operation) =>
				writeRecordKey({ collection: operation.collection, recordId: operation.id })
			)
	).size;

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
