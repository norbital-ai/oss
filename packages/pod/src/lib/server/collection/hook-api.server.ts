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
import { requireRuntimeFacility } from '$lib/server/run/facilities.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { qualifiedTableName } from '@norbital-ai/platform-utils/tenant_db/schema';
import {
	runWithBypassSecretIfValidAsync,
	runWithPermissionBypassAsync
} from './access_control/permission/permission_bypass_key.server.js';
import { assertNotificationChannelSupport } from '$lib/server/notifications/channels.js';
import {
	createMany,
	createRecord,
	deleteMany,
	deleteRecord,
	findFirst,
	findMany,
	findGrouped,
	countRecords,
	updateMany,
	updateRecord
} from './collection_ops.server.js';
import { withCollectionTransaction } from './collection_transaction.server.js';

const notificationChannelsSchema = zod.array(zod.string().min(1)).min(1).default(['system']);
const fileAssetSchema = zod.object({
	norbital_id: zod.string().uuid(),
	owner_user_id: zod.string().uuid(),
	file_name: zod.string(),
	mime_type: zod.string().nullable(),
	file_size: zod.number().int().nonnegative().nullable(),
	storage_key: zod.string()
});

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
		count: (collection, query) =>
			runWithPermissionBypassAsync(() => transport.count(collection, query))
	};
}

function readWorkspaceSchema(workspace: ReturnType<typeof getTenantWorkspace>) {
	return workspace.schema;
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
					requireRuntimeFacility('notifications').channels
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
		}) => {
			const result = await requireRuntimeFacility('ai').chat({
				messages: [{ role: 'user', content: input.prompt }],
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
		readFileAsset: async (assetId: string) => {
			const parsedAssetId = zod.string().uuid().parse(assetId);
			const workspace = getWorkspace({ provision: true });
			const result = await workspace.tenantDb.query({
				text: `SELECT norbital_id, owner_user_id, file_name, mime_type, file_size, storage_key FROM ${qualifiedTableName('document_asset')} WHERE norbital_id = $1::uuid LIMIT 1`,
				values: [parsedAssetId]
			});
			const asset = fileAssetSchema.safeParse(result.rows[0]);
			if (!asset.success) throw new Error('The selected file asset does not exist.');
			if (asset.data.owner_user_id !== workspace.baseScope.requestor.norbital_id) {
				throw new Error('The selected file asset is not accessible to this requestor.');
			}
			const bytes = await requireRuntimeFacility('fileStorage').get(asset.data.storage_key);
			if (bytes == null) throw new Error('The selected file asset is unavailable in storage.');
			if (asset.data.file_size != null && bytes.byteLength !== asset.data.file_size) {
				throw new Error('The selected file asset size does not match its stored record.');
			}
			return {
				id: asset.data.norbital_id,
				name: asset.data.file_name,
				mimeType: asset.data.mime_type,
				size: bytes.byteLength,
				bytes
			};
		}
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
		sendNotification: api.sendNotification
	};
}

export function restrictAfterHookApi(api: AfterApi): AfterHookApi {
	return {
		db: api.db,
		readFileAsset: api.readFileAsset,
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
