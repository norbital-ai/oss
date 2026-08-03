import type { z } from 'zod';
import type { AnySchema } from '../schema/types.js';
import type { DbApi } from './db-api-types.js';
import type { ReadonlyDbApi } from './db-api-types.js';
import type { MergedWorkspaceSchema } from '$lib/authoring/schema/system-workspace.js';
import type { DefaultWorkspaceSchema, TableName } from '../schema/types.js';
import type { MutationInsertFor, MutationUpdateFor } from '../schema/mutation-types.js';

export type SendNotificationInput = {
	readonly recipient_user_id: string;
	readonly subject: string;
	readonly message: string;
	/** `system` is built in; every other channel must be provided by the active host. */
	readonly channels?: readonly string[];
	readonly cta?: { readonly label: string; readonly url: string } | null;
	readonly notification_category?: string | null;
};

export type SendNotificationResult = {
	readonly notification_id: string | null;
	readonly queued_channels: readonly string[];
};

export type ReadFileAssetResult = {
	readonly id: string;
	readonly name: string;
	readonly mimeType: string | null;
	readonly size: number;
	readonly bytes: Uint8Array;
};

/** Server hook/automation/handler API — direct `db` ops (Promise, not RemoteQuery) + builtins. */
export type BeforeApi<S extends AnySchema = DefaultWorkspaceSchema> = {
	readonly db: string extends TableName<S>
		? DbApi<S, 'direct'>
		: DbApi<MergedWorkspaceSchema<S>, 'direct'>;
	readonly sendNotification: (input: SendNotificationInput) => Promise<SendNotificationResult>;
	readonly ai: <const TSchema extends z.ZodType | undefined = undefined>(input: {
		readonly prompt: string;
		readonly schema?: TSchema;
		readonly model?: string;
		readonly profile?: string;
	}) => Promise<TSchema extends z.ZodType ? z.infer<TSchema> : string>;
	readonly readFileAsset: (assetId: string) => Promise<ReadFileAssetResult>;
};

/** Transactional hook capabilities; notification writes join the caller's database transaction. */
export type HookApi<S extends AnySchema = DefaultWorkspaceSchema> = Pick<
	BeforeApi<S>,
	'db' | 'readFileAsset' | 'sendNotification'
>;

/**
 * One `mutate` payload: a create, or an update naming the row it changes.
 *
 * `mutate` is a create-*or*-update batch — a payload carrying `norbital_id` updates that record and
 * anything else is a create. That is worth stating in the type rather than in prose, because the
 * distinction is invisible at the call site: the only difference between inserting a row and rewriting
 * an existing one is the presence of a single field.
 */
type ElevatedMutationPayload<S extends AnySchema, N extends TableName<MergedWorkspaceSchema<S>>> =
	| MutationInsertFor<MergedWorkspaceSchema<S>, N>
	| ({ readonly norbital_id: string } & MutationUpdateFor<MergedWorkspaceSchema<S>, N>);

/**
 * Derived writes an `after` hook may perform, bypassing permission checks.
 *
 * Bound to the workspace schema rather than taking `(string, Record<string, unknown>[])`. This is the
 * only authoring surface that runs with permissions bypassed, so it was also the only one where a
 * misspelled collection or column reached a privileged code path before failing — the inverse of where
 * type safety is worth the most. The collection name is a generic parameter so each call correlates
 * its payloads to *that* collection.
 */
type ElevatedMutationApi<S extends AnySchema> = {
	readonly mutate: <const N extends TableName<MergedWorkspaceSchema<S>>>(
		collectionName: N,
		payloads: readonly ElevatedMutationPayload<S, N>[]
	) => Promise<Record<string, unknown>[]>;
	readonly delete: <const N extends TableName<MergedWorkspaceSchema<S>>>(
		collectionName: N,
		ids: readonly string[]
	) => Promise<void>;
};

type AfterDbApi<S extends AnySchema> = ElevatedMutationApi<S> &
	(string extends TableName<MergedWorkspaceSchema<S>>
		? object
		: ReadonlyDbApi<MergedWorkspaceSchema<S>, 'direct'>);

export type AfterApi<S extends AnySchema = DefaultWorkspaceSchema> = Omit<BeforeApi<S>, 'db'> & {
	readonly db: AfterDbApi<S>;
};

/** Post-write hooks may add derived writes and transactional notification outbox entries. */
export type AfterHookApi<S extends AnySchema = DefaultWorkspaceSchema> = Pick<
	AfterApi<S>,
	'db' | 'readFileAsset' | 'sendNotification'
>;
