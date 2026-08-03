/**
 * Permanent worker-runtime HTTP transport for tenant workspace operations.
 *
 * A compatible host invokes these `/_runtime/*` routes inside the tenant isolate. This is the
 * stable wire protocol between the host and the in-isolate Pod runtime.
 */
import { buildCtx } from '$lib/server/bootstrap/context.js';
import { runWithWorkspaceContext } from '$lib/server/bootstrap/workspace_runtime.js';
import { handleSyncRequest } from '$lib/server/collection/sync/sync-endpoints.server.js';
import {
	ProcessApprovalRequestActionInputSchema,
	WithdrawApprovalRequestInputSchema
} from '$lib/remote/approval_request/schema.js';
import {
	adminCreateSystemRecord,
	adminDeleteSystemRecord,
	adminUpdateSystemRecord,
	agentChat,
	agentChatStart,
	agentModels,
	autocompleteGeolocation,
	count,
	create,
	createMany,
	deleteRecord,
	exportPipeline,
	findGrouped,
	findHistory,
	findFirst,
	findMany,
	getCollectionDefinitions,
	importPipeline,
	update,
	updateMany
} from '$lib/remote';
import { invokeCommand, invokeHandler, invokeQuery } from '$lib/remote/handler.remote.js';
import {
	runProcessApprovalRequestAction,
	runWithdrawApprovalRequest
} from '$lib/remote/approval_request/approval_request.runtime.server.js';
import {
	InviteMemberSchema,
	RevokeInvitationSchema,
	SetMemberRoleSchema,
	inviteWorkspaceMember,
	listWorkspaceInvitations,
	revokeWorkspaceInvitation,
	setWorkspaceMemberRole
} from '$lib/server/identity/workspace_settings.server.js';
import { AgentChatInputSchema, AgentModelsInputSchema } from '$lib/remote/agent_chat.remote.js';
import { AutocompleteGeolocationInputSchema } from '$lib/remote/geolocation.remote.js';
import { StaticMapInputSchema } from '@norbital-ai/platform-utils/runtime/binding';
import { renderStaticMap } from '$lib/remote/static_map.remote.js';
import {
	AdminSystemCreateSchema,
	AdminSystemDeleteSchema,
	AdminSystemUpdateSchema
} from '$lib/remote/collection.remote.js';
import {
	CountWireSchema,
	CreateManyWireSchema,
	CreateWireSchema,
	DeleteWireSchema,
	ExportRecordsWireSchema,
	FindGroupedWireSchema,
	FindHistoryWireSchema,
	FindFirstWireSchema,
	FindManyWireSchema,
	ImportRecordsWireSchema,
	UpdateManyWireSchema,
	UpdateWireSchema
} from '@norbital-ai/platform-utils/remote/collection_wire_schemas';
import { noInputSchema } from '@norbital-ai/platform-utils/remote';
import { qualifiedTableName } from '@norbital-ai/platform-utils/tenant_db/schema';
import { error, json } from '$lib/runtime/http.js';
import type { PodRequestEvent } from '$lib/runtime/request-context.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import {
	createRecord as createCollectionRecord,
	deleteRecord as deleteCollectionRecord
} from '$lib/server/collection/collection_ops.server.js';
import { z } from 'zod';
import { startInteractiveAgent } from '$lib/server/agent/agent-loop.server.js';

const MAX_WORKSPACE_FILE_SIZE = 10 * 1024 * 1024;
const fileUploadSchema = z.object({
	file_name: z.string().trim().min(1).max(255),
	mime_type: z.string().trim().min(1).max(255),
	file_size: z.number().int().nonnegative().max(MAX_WORKSPACE_FILE_SIZE),
	data_base64: z.string().min(1)
});
const fileDeleteSchema = z.object({ record_id: z.string().uuid() });
const agentStartSchema = z.object({
	message: z.string().trim().min(1),
	runId: z.string().uuid().optional()
});
const documentAssetSchema = z.object({
	norbital_id: z.string().uuid(),
	storage_key: z.string(),
	owner_user_id: z.string().uuid()
});

function decodeBase64File(encoded: string, expectedSize: number): Uint8Array {
	let binary: string;
	try {
		binary = atob(encoded);
	} catch {
		throw error(400, 'File payload is not valid base64.');
	}
	if (binary.length !== expectedSize) throw error(400, 'File payload size does not match.');
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function storageExtension(fileName: string): string {
	return fileName.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? '';
}

async function uploadWorkspaceFile(event: PodRequestEvent, body: unknown) {
	const input = parseWireBody(fileUploadSchema, body);
	const fileStorage = event.platform.bindings.fileStorage;
	if (!fileStorage) throw error(503, 'Workspace file storage is unavailable.');
	const bytes = decodeBase64File(input.data_base64, input.file_size);
	const storageKey = `document-assets/${crypto.randomUUID()}${storageExtension(input.file_name)}`;
	const ownerUserId = getWorkspace({ provision: true }).baseScope.requestor.norbital_id;
	await fileStorage.put(storageKey, bytes, input.mime_type);
	try {
		const record = await createCollectionRecord(
			getWorkspace({ provision: true }),
			'document_asset',
			{
				owner_user_id: ownerUserId,
				file_name: input.file_name,
				mime_type: input.mime_type,
				file_size: input.file_size,
				storage_key: storageKey
			},
			{ isElevated: true }
		);
		const recordId = record.norbital_id;
		if (typeof recordId !== 'string') throw new Error('Document asset has no record id.');
		return {
			norbital_id: recordId,
			name: input.file_name,
			type: input.mime_type,
			size: input.file_size
		};
	} catch (cause) {
		try {
			await fileStorage.delete(storageKey);
		} catch (cleanupCause) {
			console.error('[workspace-file-upload] orphan cleanup failed', cleanupCause);
		}
		throw cause;
	}
}

async function deleteWorkspaceFile(event: PodRequestEvent, body: unknown) {
	const input = parseWireBody(fileDeleteSchema, body);
	const fileStorage = event.platform.bindings.fileStorage;
	if (!fileStorage) throw error(503, 'Workspace file storage is unavailable.');
	const workspace = getWorkspace({ provision: true });
	const result = await workspace.tenantDb.query({
		text: `SELECT norbital_id, storage_key, owner_user_id FROM ${qualifiedTableName('document_asset')} WHERE norbital_id = $1::uuid LIMIT 1`,
		values: [input.record_id]
	});
	const rawRecord = result.rows[0];
	const record = documentAssetSchema.safeParse(rawRecord);
	if (!record.success) throw error(404, 'Uploaded file does not exist.');
	if (record.data.owner_user_id !== workspace.baseScope.requestor.norbital_id) {
		throw error(403, 'Only the uploader can remove this file.');
	}
	await fileStorage.delete(record.data.storage_key);
	await deleteCollectionRecord(workspace, 'document_asset', record.data.norbital_id, {
		isElevated: true
	});
	return { deleted: true };
}

type RuntimeEndpointHandler = (body: unknown) => Promise<unknown>;

function parseWireBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
	try {
		return schema.parse(body);
	} catch (err) {
		if (err instanceof z.ZodError) {
			throw error(400, `Invalid request body: ${err.message}`);
		}
		throw err;
	}
}

function wireEndpoint<S extends z.ZodType>(
	schema: S,
	handler: (input: z.infer<S>) => Promise<unknown>
): RuntimeEndpointHandler {
	return (body) => handler(parseWireBody(schema, body));
}

const RUNTIME_ENDPOINT_HANDLERS: Record<string, RuntimeEndpointHandler> = {
	'collections/admin/create': wireEndpoint(AdminSystemCreateSchema, adminCreateSystemRecord),
	'collections/admin/update': wireEndpoint(AdminSystemUpdateSchema, adminUpdateSystemRecord),
	'collections/admin/delete': wireEndpoint(AdminSystemDeleteSchema, adminDeleteSystemRecord),
	'collections/definitions': wireEndpoint(noInputSchema, getCollectionDefinitions),
	'collections/findMany': wireEndpoint(FindManyWireSchema, findMany),
	'collections/findFirst': wireEndpoint(FindFirstWireSchema, findFirst),
	'collections/findGrouped': wireEndpoint(FindGroupedWireSchema, findGrouped),
	'collections/findHistory': wireEndpoint(FindHistoryWireSchema, findHistory),
	'collections/count': wireEndpoint(CountWireSchema, count),
	'collections/create': wireEndpoint(CreateWireSchema, create),
	'collections/createMany': wireEndpoint(CreateManyWireSchema, createMany),
	'collections/update': wireEndpoint(UpdateWireSchema, update),
	'collections/updateMany': wireEndpoint(UpdateManyWireSchema, updateMany),
	'collections/deleteRecord': wireEndpoint(DeleteWireSchema, deleteRecord),
	'collections/export': wireEndpoint(ExportRecordsWireSchema, exportPipeline),
	'collections/import': wireEndpoint(ImportRecordsWireSchema, importPipeline),
	'remotes/agentChat': wireEndpoint(AgentChatInputSchema, agentChat),
	'remotes/agentChatStart': wireEndpoint(AgentChatInputSchema, agentChatStart),
	'remotes/agentModels': wireEndpoint(AgentModelsInputSchema, agentModels),
	'remotes/autocompleteGeolocation': wireEndpoint(
		AutocompleteGeolocationInputSchema,
		autocompleteGeolocation
	),
	'remotes/renderStaticMap': wireEndpoint(StaticMapInputSchema, renderStaticMap),
	'remotes/processApprovalRequestAction': wireEndpoint(
		ProcessApprovalRequestActionInputSchema,
		runProcessApprovalRequestAction
	),
	'remotes/withdrawApprovalRequest': wireEndpoint(
		WithdrawApprovalRequestInputSchema,
		runWithdrawApprovalRequest
	),
	// Workspace administration. `settings/invitations*` exists because `invitation` is client-opaque
	// and must stay that way — these project the fields an admin needs and never `token_hash`. Teams
	// and their policy assignment need nothing new: `collections/admin/*` above already writes the
	// system collections behind the same admin check.
	'settings/invitations': wireEndpoint(noInputSchema, listWorkspaceInvitations),
	'settings/invitations/create': wireEndpoint(InviteMemberSchema, inviteWorkspaceMember),
	'settings/invitations/revoke': wireEndpoint(RevokeInvitationSchema, revokeWorkspaceInvitation),
	'settings/members/role': wireEndpoint(SetMemberRoleSchema, setWorkspaceMemberRole),
	'invoke/command': (body) => invokeCommand(body),
	'invoke/query': (body) => invokeQuery(body),
	invoke: (body) => invokeHandler(body)
};

const jsonBodySchema = z.unknown();

async function readJsonBody(event: PodRequestEvent): Promise<unknown> {
	try {
		return jsonBodySchema.parse(await event.request.json());
	} catch {
		const raw = event.request.headers.get('x-norbital-invoke-body');
		if (!raw) {
			throw error(400, 'Invalid JSON body');
		}
		try {
			return jsonBodySchema.parse(JSON.parse(raw));
		} catch {
			throw error(400, 'Invalid JSON body');
		}
	}
}

const kitErrorSchema = z.object({
	status: z.number(),
	body: z.unknown().optional()
});

function rethrowKitError(err: unknown): never {
	const parsed = kitErrorSchema.safeParse(err);
	if (parsed.success) {
		const { status, body } = parsed.data;
		if (typeof body === 'string') {
			throw error(status, body);
		}
		if (body && typeof body === 'object') {
			const message = Reflect.get(body, 'message');
			if (typeof message === 'string') {
				throw error(status, message);
			}
			if (message !== undefined) {
				throw error(
					status,
					typeof message === 'object' ? JSON.stringify(message) : String(message)
				);
			}
			throw error(status, JSON.stringify(body));
		}
		throw err;
	}
	throw err;
}

export async function handleNorbitalRuntimeRequest(event: PodRequestEvent): Promise<Response> {
	const startedAt = performance.now();
	const responseHeaders = (): HeadersInit => {
		const requestId = event.request.headers.get('x-norbital-request-id');
		return {
			'server-timing': `runtime_execution;dur=${(performance.now() - startedAt).toFixed(1)}`,
			...(requestId ? { 'x-norbital-request-id': requestId } : {})
		};
	};
	const routePath = event.params.path?.replace(/^\//, '') ?? '';

	// Sync-engine routes branch BEFORE the JSON body is consumed: `stream` holds the request
	// open for SSE (GET, no body) and `subscribe`/`mutate` read their own body. They also
	// return their own Response (streaming or JSON) instead of the json(...) wrapper below.
	if (routePath.startsWith('sync/')) {
		const ctx = await buildCtx(event);
		if (!ctx) {
			throw error(401, 'Unauthorized');
		}
		return runWithWorkspaceContext(ctx, () =>
			handleSyncRequest(routePath.slice('sync/'.length), event, ctx, responseHeaders())
		);
	}

	const body = await readJsonBody(event);
	const ctx = await buildCtx(event);
	if (!ctx) {
		throw error(401, 'Unauthorized');
	}

	if (routePath === 'files/upload') {
		const result = await runWithWorkspaceContext(ctx, () => uploadWorkspaceFile(event, body));
		return json(result, { headers: responseHeaders() });
	}
	if (routePath === 'files/delete') {
		const result = await runWithWorkspaceContext(ctx, () => deleteWorkspaceFile(event, body));
		return json(result, { headers: responseHeaders() });
	}
	if (routePath === 'agent/start') {
		const input = parseWireBody(agentStartSchema, body);
		const result = await runWithWorkspaceContext(ctx, () => startInteractiveAgent(input));
		return json(result, { headers: responseHeaders() });
	}

	const handler = RUNTIME_ENDPOINT_HANDLERS[routePath];
	if (!handler) {
		throw error(404, `Unknown norbital runtime route: ${routePath}`);
	}

	try {
		const result = await runWithWorkspaceContext(ctx, () => handler(body));
		return json(result ?? null, { headers: responseHeaders() });
	} catch (err) {
		rethrowKitError(err);
	}
}
