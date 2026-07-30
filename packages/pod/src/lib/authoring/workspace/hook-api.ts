import type { z } from 'zod';
import type { AnySchema } from '../schema/types.js';
import type { DbApi } from './db-api-types.js';
import type { ReadonlyDbApi } from './db-api-types.js';
import type { MergedWorkspaceSchema } from '$lib/authoring/schema/system-workspace.js';
import type { TableName } from '../schema/types.js';
import type { WorkspaceAuthoringTypes } from '../index.js';

type DefaultWorkspaceSchema = WorkspaceAuthoringTypes extends {
	readonly schema: infer TSchema extends AnySchema;
}
	? TSchema
	: AnySchema;

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

type ElevatedMutationApi = {
	readonly mutate: (
		collectionName: string,
		payloads: Record<string, unknown>[]
	) => Promise<Record<string, unknown>[]>;
	readonly delete: (collectionName: string, ids: string[]) => Promise<void>;
};

type AfterDbApi<S extends AnySchema> = ElevatedMutationApi &
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
