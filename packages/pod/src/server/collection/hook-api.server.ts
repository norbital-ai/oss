import type {
	AfterApi,
	AfterHookApi,
	BeforeApi,
	HookApi
} from '$lib/authoring/workspace/hook-api.js';
import {
	createDbApi,
	createElevatedReadonlyDbApi,
	createReadonlyDbApi,
	type DirectDbTransport
} from '$lib/authoring/workspace/db-api.js';
import { mergePlatformSchema } from '$lib/authoring/schema/system-workspace.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { z as zod } from 'zod';
import { requireRuntimeFacility } from '$lib/server/facilities.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { qualifiedTableName } from '@norbital-ai/platform-utils/tenant_db/schema';
import {
	getCurrentPermissionBypassKey,
	runWithBypassSecretIfValidAsync,
	runWithPermissionBypassAsync
} from './access_control/permission/permission_bypass_key.server.js';
import { assertNotificationChannelSupport } from '$lib/server/notification-outbox.server.js';
import {
	createMany,
	createRecord,
	deleteMany,
	deleteRecord,
	findFirst,
	findMany,
	findNearest,
	findGrouped,
	countRecords,
	updateMany,
	updateRecord
} from './collection_ops.server.js';
import { withCollectionTransaction } from './collection_transaction.server.js';
import {
	automationReplayStorage,
	replayAutomationAi
} from '$lib/server/run/automation-replay.server.js';
import { createHash } from 'node:crypto';

const notificationChannelsSchema = zod.array(zod.string().min(1)).min(1).default(['system']);
const fileAssetSchema = zod.object({
	norbital_id: zod.string().uuid(),
	owner_user_id: zod.string().uuid(),
	file_name: zod.string(),
	mime_type: zod.string().nullable(),
	file_size: zod.number().int().nonnegative().nullable(),
	storage_key: zod.string()
});
const MAX_AI_IMAGES = 8;
const MAX_AI_IMAGE_BYTES = 20 * 1024 * 1024;
const inspectionProfileSchema = zod
	.string()
	.regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
	.max(128);
const inspectionAssetIdsSchema = zod.array(zod.string().uuid()).min(1).max(512);

function buildDirectTransport(): DirectDbTransport {
	return {
		findMany: (collection, query) => {
			const ctx = getWorkspace({ provision: true });
			const { bypass_secret, ...rest } = query;
			return runWithBypassSecretIfValidAsync(bypass_secret, () => findMany(ctx, collection, rest));
		},
		findFirst: (collection, query) => {
			const ctx = getWorkspace({ provision: true });
			const { bypass_secret, ...rest } = query;
			return runWithBypassSecretIfValidAsync(bypass_secret, () => findFirst(ctx, collection, rest));
		},
		findGrouped: (collection, query) => {
			const ctx = getWorkspace({ provision: true });
			const { bypass_secret, ...rest } = query;
			return runWithBypassSecretIfValidAsync(bypass_secret, () =>
				findGrouped(ctx, collection, rest)
			);
		},
		findNearest: (collection, query) => {
			const ctx = getWorkspace({ provision: true });
			const { bypass_secret, ...rest } = query;
			return runWithBypassSecretIfValidAsync(bypass_secret, () =>
				findNearest(ctx, collection, rest)
			);
		},
		count: (collection, query) => {
			const ctx = getWorkspace({ provision: true });
			const { bypass_secret, ...rest } = query;
			return runWithBypassSecretIfValidAsync(bypass_secret, () =>
				countRecords(ctx, collection, rest)
			);
		},
		create: (collection, input) => {
			const ctx = getWorkspace({ provision: true });
			return createRecord(ctx, collection, input);
		},
		createMany: (collection, inputs) => {
			const ctx = getWorkspace({ provision: true });
			return createMany(ctx, collection, inputs);
		},
		update: (collection, recordId, input) => {
			const ctx = getWorkspace({ provision: true });
			return updateRecord(ctx, collection, recordId, input);
		},
		updateMany: (collection, updates) => {
			const ctx = getWorkspace({ provision: true });
			return updateMany(ctx, collection, updates);
		},
		delete: (collection, recordId) => {
			const ctx = getWorkspace({ provision: true });
			return deleteRecord(ctx, collection, recordId);
		}
	};
}

function buildElevatedReadTransport(): DirectDbTransport {
	const transport = buildDirectTransport();
	return {
		...transport,
		findMany: (collection, query) =>
			runWithPermissionBypassAsync(() => transport.findMany(collection, query)),
		findFirst: (collection, query) =>
			runWithPermissionBypassAsync(() => transport.findFirst(collection, query)),
		findGrouped: (collection, query) =>
			runWithPermissionBypassAsync(() => transport.findGrouped(collection, query)),
		findNearest: (collection, query) =>
			runWithPermissionBypassAsync(() => transport.findNearest(collection, query)),
		count: (collection, query) =>
			runWithPermissionBypassAsync(() => transport.count(collection, query))
	};
}

function readWorkspaceSchema(workspace: ReturnType<typeof getTenantWorkspace>) {
	return workspace.schema;
}

async function accessibleFileAsset(assetId: string) {
	const parsedAssetId = zod.string().uuid().parse(assetId);
	const workspace = getWorkspace({ provision: true });
	const result = await workspace.tenantDb.query({
		text: `SELECT norbital_id, owner_user_id, file_name, mime_type, file_size, storage_key FROM ${qualifiedTableName('document_asset')} WHERE norbital_id = $1::uuid LIMIT 1`,
		values: [parsedAssetId]
	});
	const asset = fileAssetSchema.safeParse(result.rows[0]);
	if (!asset.success) throw new Error('The selected file asset does not exist.');
	if (
		getCurrentPermissionBypassKey() == null &&
		asset.data.owner_user_id !== workspace.baseScope.requestor.norbital_id
	) {
		throw new Error('The selected file asset is not accessible to this requestor.');
	}
	return asset.data;
}

async function accessibleFileAssets(assetIds: readonly string[]) {
	const parsedAssetIds = inspectionAssetIdsSchema.parse(assetIds);
	const workspace = getWorkspace({ provision: true });
	const result = await workspace.tenantDb.query({
		text: `SELECT norbital_id, owner_user_id, file_name, mime_type, file_size, storage_key FROM ${qualifiedTableName('document_asset')} WHERE norbital_id = ANY($1::uuid[])`,
		values: [parsedAssetIds]
	});
	const byId = new Map(
		result.rows.flatMap((row) => {
			const asset = fileAssetSchema.safeParse(row);
			return asset.success ? [[asset.data.norbital_id, asset.data] as const] : [];
		})
	);
	return parsedAssetIds.map((assetId) => {
		const asset = byId.get(assetId);
		if (asset == null) throw new Error('The selected file asset does not exist.');
		if (
			getCurrentPermissionBypassKey() == null &&
			asset.owner_user_id !== workspace.baseScope.requestor.norbital_id
		) {
			throw new Error('The selected file asset is not accessible to this requestor.');
		}
		return asset;
	});
}

async function readFileAsset(assetId: string) {
	const asset = await accessibleFileAsset(assetId);
	const bytes = await requireRuntimeFacility('fileStorage').get(asset.storage_key);
	if (bytes == null) throw new Error('The selected file asset is unavailable in storage.');
	if (asset.file_size != null && bytes.byteLength !== asset.file_size) {
		throw new Error('The selected file asset size does not match its stored record.');
	}
	return {
		id: asset.norbital_id,
		name: asset.file_name,
		mimeType: asset.mime_type,
		size: bytes.byteLength,
		storageKey: asset.storage_key,
		bytes
	};
}

async function readFileAssetInspection(assetId: string, profile: string) {
	const asset = await accessibleFileAsset(assetId);
	const storage = requireRuntimeFacility('fileStorage');
	if (storage.getInspection == null) return null;
	const inspected = await storage.getInspection(
		asset.storage_key,
		inspectionProfileSchema.parse(profile)
	);
	if (inspected == null) return null;
	return {
		id: asset.norbital_id,
		name: asset.file_name,
		mimeType: asset.mime_type,
		size: asset.file_size ?? 0,
		contentSha256: inspected.contentSha256,
		facts: inspected.facts
	};
}

async function readFileAssetInspections(assetIds: readonly string[], profile: string) {
	const assets = await accessibleFileAssets(assetIds);
	const storage = requireRuntimeFacility('fileStorage');
	const parsedProfile = inspectionProfileSchema.parse(profile);
	const inspected = storage.getInspections
		? await storage.getInspections(
				assets.map((asset) => ({ key: asset.storage_key, profile: parsedProfile }))
			)
		: await Promise.all(
				assets.map((asset) => storage.getInspection?.(asset.storage_key, parsedProfile) ?? null)
			);
	if (inspected.length !== assets.length) {
		throw new Error('File inspection facility returned an invalid result count.');
	}
	return assets.map((asset, index) => {
		const entry = inspected[index];
		return entry == null
			? null
			: {
					id: asset.norbital_id,
					name: asset.file_name,
					mimeType: asset.mime_type,
					size: asset.file_size ?? 0,
					contentSha256: entry.contentSha256,
					facts: entry.facts
				};
	});
}

function sharedBuiltinApi() {
	return {
		sendNotification: async (input: Parameters<BeforeApi['sendNotification']>[0]) => {
			const ctx = getWorkspace({ provision: true });
			const channels = [...new Set(notificationChannelsSchema.parse(input.channels))];
			const external = channels.filter((channel) => channel !== 'system');
			if (external.length > 0) {
				assertNotificationChannelSupport(
					external,
					await requireRuntimeFacility('messaging').listChannels()
				);
			}
			return withCollectionTransaction(ctx, async () => {
				let notificationId: string | null = null;
				if (channels.includes('system')) {
					const notification = await createRecord(
						ctx,
						'notification',
						{
							recipient_user_id: input.recipient_user_id,
							subject: input.subject,
							message: input.message,
							channels: ['system'],
							cta_label: input.cta?.label ?? null,
							cta_url: input.cta?.url ?? null,
							notification_category: input.notification_category ?? null,
							read_at: null
						},
						{ isElevated: true }
					);
					notificationId =
						typeof notification.norbital_id === 'string' ? notification.norbital_id : null;
				}
				for (const channel of external) {
					await createRecord(
						ctx,
						'notification_outbox',
						{
							channel,
							recipient_user_id: input.recipient_user_id,
							subject: input.subject,
							message: input.message,
							cta_label: input.cta?.label ?? null,
							cta_url: input.cta?.url ?? null,
							status: 'pending',
							attempts: 0
						},
						{ isElevated: true }
					);
				}
				return { notification_id: notificationId, queued_channels: external };
			});
		},
		ai: async (input: {
			readonly prompt: string;
			readonly schema?: zod.ZodType;
			readonly model?: string;
			readonly profile?: string;
			readonly images?: readonly {
				readonly assetId: string;
				readonly detail?: 'auto' | 'low' | 'high';
			}[];
		}) => {
			const imageInputs = input.images ?? [];
			if (imageInputs.length > MAX_AI_IMAGES) {
				throw new Error(`AI inference accepts at most ${MAX_AI_IMAGES} images per request.`);
			}
			if (automationReplayStorage.getStore()) {
				const imageAssets = await Promise.all(
					imageInputs.map(async (image) => ({ input: image, asset: await readFileAsset(image.assetId) }))
				);
				const totalImageBytes = imageAssets.reduce((sum, entry) => sum + entry.asset.size, 0);
				if (totalImageBytes > MAX_AI_IMAGE_BYTES) {
					throw new Error('AI image inputs exceed the 20 MiB request limit.');
				}
				return replayAutomationAi({
					request: {
						prompt: input.prompt,
						...(input.schema ? { outputSchema: zod.toJSONSchema(input.schema) } : {}),
						...(input.model ? { model: input.model } : {}),
						...(input.profile ? { profile: input.profile } : {}),
						...(imageAssets.length > 0
							? {
									images: imageAssets.map(({ input: image, asset }) => ({
										assetId: asset.id,
										storageKey: asset.storageKey,
										mimeType: asset.mimeType ?? 'application/octet-stream',
										byteLength: asset.size,
										contentSha256: createHash('sha256').update(asset.bytes).digest('hex'),
										...(image.detail ? { detail: image.detail } : {})
									}))
								}
							: {})
					},
					schema: input.schema
				});
			}
			const imageAssets = await Promise.all(
				imageInputs.map(async (image) => ({
					input: image,
					asset: await readFileAsset(image.assetId)
				}))
			);
			let totalImageBytes = 0;
			for (const { asset } of imageAssets) {
				if (asset.mimeType == null || !asset.mimeType.toLowerCase().startsWith('image/')) {
					throw new Error(`AI image input ${asset.id} is not an image asset.`);
				}
				totalImageBytes += asset.size;
			}
			if (totalImageBytes > MAX_AI_IMAGE_BYTES) {
				throw new Error('AI image inputs exceed the 20 MiB request limit.');
			}
			const content =
				imageAssets.length === 0
					? input.prompt
					: [
							{ type: 'text' as const, text: input.prompt },
							...imageAssets.map(({ input: image, asset }) => ({
								type: 'image' as const,
								bytes: asset.bytes,
								mimeType: asset.mimeType as string,
								...(image.detail ? { detail: image.detail } : {})
							}))
						];
			const result = await requireRuntimeFacility('ai').chat({
				messages: [{ role: 'user', content }],
				...(input.schema ? { outputSchema: zod.toJSONSchema(input.schema) } : {}),
				...(input.model ? { model: input.model } : {}),
				...(input.profile ? { profile: input.profile } : {})
			});
			if (!input.schema) return result.text;
			let parsed: unknown;
			try {
				parsed = JSON.parse(result.text);
			} catch {
				throw new Error('AI provider returned invalid JSON for a structured response');
			}
			return input.schema.parse(parsed);
		},
		readFileAsset,
		readFileAssetInspection,
		readFileAssetInspections
	};
}

function toBeforeApi(api: ReturnType<typeof sharedBuiltinApi> & { db: unknown }): BeforeApi {
	// Runtime collection names are manifest-validated; tenant schema generics exist only for authors.
	return api as unknown as BeforeApi; // stupidity: boundary-cast — manifest-validated collection generics are erased at runtime.
}

function toAfterApi(api: unknown): AfterApi {
	// Runtime collection names are manifest-validated; elevated writes stay generic.
	return api as unknown as AfterApi; // stupidity: boundary-cast — the API has function members, not serializable data.
}

export function createBeforeApi(): BeforeApi {
	const workspace = getTenantWorkspace();
	const schema = readWorkspaceSchema(workspace);
	const transport = buildDirectTransport();
	// Collection behaviors gate which mutation ops exist on api.db — without
	// them the hook api is read-only and hooks like payslip locking
	// (api.db.payslips.update) throw "update is not a function". Mirror the
	// client-side buildWorkspaceApi surface.
	const db = createDbApi(
		mergePlatformSchema(schema),
		{ mode: 'direct', transport },
		workspace.collections
	);
	return toBeforeApi({ db, ...sharedBuiltinApi() });
}

export function restrictBeforeHookApi(api: BeforeApi): HookApi {
	return {
		db: api.db,
		readFileAsset: api.readFileAsset,
		readFileAssetInspection: api.readFileAssetInspection,
		readFileAssetInspections: api.readFileAssetInspections,
		sendNotification: api.sendNotification
	};
}

export function restrictAfterHookApi(api: AfterApi): AfterHookApi {
	return {
		db: api.db,
		readFileAsset: api.readFileAsset,
		readFileAssetInspection: api.readFileAssetInspection,
		readFileAssetInspections: api.readFileAssetInspections,
		sendNotification: api.sendNotification
	};
}

export function createElevatedAfterApi(): AfterApi {
	const workspace = getTenantWorkspace();
	const readDb = createReadonlyDbApi(mergePlatformSchema(readWorkspaceSchema(workspace)), {
		mode: 'direct',
		transport: buildElevatedReadTransport()
	});
	return toAfterApi({
		...sharedBuiltinApi(),
		db: createElevatedReadonlyDbApi(readDb, {
			mutate: async (collectionName: string, payloads: Record<string, unknown>[]) => {
				return runWithPermissionBypassAsync(async () => {
					const ctx = getWorkspace({ provision: true });
					const updates = payloads.flatMap((input) => {
						const recordId = input.norbital_id;
						return typeof recordId === 'string' && recordId.length > 0 ? [{ recordId, input }] : [];
					});
					if (updates.length === 0) {
						return createMany(ctx, collectionName, payloads, { isElevated: true });
					}
					// A batch that names every record is an update batch: updateMany applies the same
					// per-record semantics in caller order, atomically, without a transaction, a read
					// and an audit write per record.
					if (updates.length === payloads.length) {
						return updateMany(ctx, collectionName, updates, { isElevated: true });
					}

					const rows: Record<string, unknown>[] = [];
					// stupidity:allow A6 -- mixed mutation hooks must observe caller order.
					for (const payload of payloads) {
						const recordId = payload.norbital_id;
						if (typeof recordId === 'string' && recordId.length > 0) {
							rows.push(
								await updateRecord(ctx, collectionName, recordId, payload, { isElevated: true })
							);
						} else {
							rows.push(await createRecord(ctx, collectionName, payload, { isElevated: true }));
						}
					}
					return rows;
				});
			},
			delete: async (collectionName: string, ids: string[]) => {
				return runWithPermissionBypassAsync(async () => {
					const ctx = getWorkspace({ provision: true });
					// deleteMany still runs the delete hooks and writes the audit trail in caller
					// order — it just stops paying a round trip per record to do it.
					await deleteMany(ctx, collectionName, ids, { isElevated: true });
				});
			}
		})
	});
}
