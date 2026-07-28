import type { z } from 'zod';
import type { AnySchema } from '../schema/types.js';
import type { DbApi } from './db-api-types.js';
import type { ReadonlyDbApi } from './db-api-types.js';
import type { MergedWorkspaceSchema } from '$lib/authoring/schema/system-workspace.js';
import type { TableName } from '../schema/types.js';

export type SendNotificationInput = {
	readonly recipient_user_id: string;
	readonly subject: string;
	readonly message: string;
	readonly channels?: readonly string[];
	readonly cta?: { readonly label: string; readonly url: string } | null;
	readonly notification_category?: string | null;
};

export type SendNotificationResult = {
	readonly notification_id: string;
	readonly delivery: Record<string, unknown>;
};

export type ReadFileAssetResult = {
	readonly id: string;
	readonly name: string;
	readonly mimeType: string | null;
	readonly size: number;
	readonly bytes: Uint8Array;
};

/** Server hook/automation/handler API — direct `db` ops (Promise, not RemoteQuery) + builtins. */
export type BeforeApi<S extends AnySchema = AnySchema> = {
	readonly db: string extends TableName<S>
		? DbApi<S, 'direct'>
		: DbApi<MergedWorkspaceSchema<S>, 'direct'>;
	readonly sendNotification: (input: SendNotificationInput) => Promise<SendNotificationResult>;
	readonly aiInferStructured: <const TSchema extends z.ZodType>(
		schema: TSchema,
		input: { readonly prompt: string; readonly temperature?: number }
	) => Promise<z.infer<TSchema>>;
	readonly readFileAsset: (assetId: string) => Promise<ReadFileAssetResult>;
	readonly fetch: typeof fetch;
};

/** Transactional collection-hook capabilities: database work plus deterministic asset reads only. */
export type HookApi<S extends AnySchema = AnySchema> = Pick<BeforeApi<S>, 'db' | 'readFileAsset'>;

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

export type AfterApi<S extends AnySchema = AnySchema> = Omit<BeforeApi<S>, 'db'> & {
	readonly db: AfterDbApi<S>;
};

/** Post-write collection hooks retain derived database writes but cannot perform external delivery. */
export type AfterHookApi<S extends AnySchema = AnySchema> = Pick<
	AfterApi<S>,
	'db' | 'readFileAsset'
>;
