/** The operations one write commits, and what a committed graph reports. */
import type { Schema } from 'effect';
import type { EffectId, ChangeBatch } from '@norbital-ai/bolt-protocol';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import type * as AccessControl from '#lib/runtime/access/access-control.js';

/**
 * One row the plan writes: its action, the values already encoded for the wire, the definition
 * that types its statement, the caller's predicate the transaction asserts, and the stored row it
 * was prepared against when it exists.
 */
export type GraphPreparedOperation = Readonly<{
	readonly action: 'create' | 'update' | 'delete';
	readonly collection: string;
	readonly id: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
	readonly definition: WorkspaceDefinition['collections'][number];
	readonly visibility: AccessControl.RowPredicate;
	readonly previous?: Readonly<Record<string, unknown>>;
	readonly depth: number;
	readonly taskScope: EffectId;
	readonly snapshot?: string;
}>;

export type AppliedDeclarativeGraph = Readonly<{
	readonly operations: ReadonlyArray<GraphPreparedOperation>;
	readonly records: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
	readonly batch: ChangeBatch;
}>;
