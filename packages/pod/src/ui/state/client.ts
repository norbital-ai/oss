import { setWorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';
import type { WorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';
import type { PodRemoteOperations } from '$lib/authoring/workspace/pod-remote-operations.js';
import {
	ReactiveRemoteQuery,
	RemoteQueryResourceManager,
	remoteQueryKey
} from '$lib/ui/state/remote-query.svelte.js';
import {
	absorbServerRows,
	getClientSync,
	localCount,
	localFindFirst,
	localFindMany,
	reconcileServerRow,
	setLocalSchema,
	setSyncInvalidator,
	setSyncReadyInvalidator,
	syncMutate,
	type LocalCollectionSchema
} from '$lib/ui/sync/client-sync.js';
import { clientSyncReady } from '$lib/ui/sync/replica.js';
import { isSearchableCollectionField } from '@norbital-ai/platform-utils/collection';
import { mutationRejectionMessage } from '$lib/ui/sync/mutation-rejection.js';
import type { WireMutation } from '$lib/ui/sync/types.js';
import type { TGeolocation } from '$lib/authoring/builtin/custom_types.js';
import type { AnySchema } from '$lib/authoring/schema/types.js';
import type { InvokeMap } from '$lib/authoring/workspace/invoke-api-types.js';
import type { WorkspaceClient } from '$lib/ui/state/workspace-client.js';
import type { CollectionColumnMap } from '@norbital-ai/platform-utils/manifest/context';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { implicitQuerySystemColumnSpecs } from '@norbital-ai/platform-utils/system/column_names';
import type {
	CollectionApprovalRequest,
	CollectionClient,
	CollectionDefinition,
	CollectionPage,
	CollectionRecordHistoryEntry,
	CollectionRegistry,
	ErasedCollectionRegistry,
	RemoteQuery
} from '@norbital-ai/platform-utils/collection';
import {
	collectionPageRows,
	createCollectionClient
} from '@norbital-ai/platform-utils/collection/client';
import type { Component } from 'svelte';

export type WorkspaceAppLoader = () => Promise<Component>;

type RemotePayload = Readonly<Record<string, unknown>>;

function requestKeyHash(key: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function opaqueQueryScope(value: unknown): string | null {
	if (value == null) return null;
	const serialized = typeof value === 'string' ? value : JSON.stringify(value);
	return `opaque:${requestKeyHash(serialized)}`;
}

export async function post<T>(
	path: string,
	body: unknown,
	signal?: AbortSignal,
	queryKey?: string
): Promise<T> {
	const response = await fetch(`/_runtime/${path}`, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'content-type': 'application/json',
			'x-norbital-request-id': crypto.randomUUID(),
			...(queryKey ? { 'x-norbital-query-key': requestKeyHash(queryKey) } : {})
		},
		body: JSON.stringify(body),
		signal
	});
	const payload: unknown = await response.json();
	if (!response.ok) {
		const message =
			payload && typeof payload === 'object' && typeof Reflect.get(payload, 'message') === 'string'
				? Reflect.get(payload, 'message')
				: `Pod request failed (${response.status})`;
		throw new Error(message);
	}
	return payload as T;
}

/**
 * The group of reads a new query may inherit its first rows from.
 *
 * A family is one truthful SLICE of a collection: same collection, operation, structural scope and
 * position. Re-sorting or searching that slice may reuse its previous rows while the next answer
 * lands. Changing `where`, selected relationships, or projected columns may not: an empty result
 * from another company is not evidence that this company is empty, and must show a loader instead.
 *
 * A different page is not. Page 2's rows are not an approximation of page 3's, they are other
 * records, and inheriting them would show the old page under the new heading with no loader —
 * reporting data as arrived when it has not. So the cursor is part of the family, and moving to a
 * page this device has not got yet starts with nothing, which is exactly when a loader is honest.
 *
 * Keyset cursors are opaque, so this only has to distinguish them, never interpret them.
 */
export function remoteQueryFamily(keyPrefix: string, path: string, body: unknown): string {
	const input =
		body && typeof body === 'object' && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: {};
	return remoteQueryKey(keyPrefix, path, {
		after: typeof input.after === 'string' ? input.after : '',
		limit: typeof input.limit === 'number' ? input.limit : null,
		where: input.where ?? null,
		with: input.with ?? null,
		columns: input.columns ?? null,
		filters: input.filters ?? null,
		bypass_scope: opaqueQueryScope(input.bypass_secret)
	});
}

function query<T>(
	manager: RemoteQueryResourceManager<T>,
	keyPrefix: string,
	path: string,
	body: unknown,
	local?: () => Promise<T | null | undefined>,
	absorb?: (value: T) => void
): ReactiveRemoteQuery<T> {
	const key = remoteQueryKey(keyPrefix, path, body);
	const family = remoteQueryFamily(keyPrefix, path, body);
	return manager.query(
		key,
		async (signal) => {
			// Never put the first useful server answer behind replica startup or a collection warm-up.
			// If sync is already open, a provably complete local answer wins. Otherwise the authoritative
			// query starts now; the replica-ready invalidator re-runs it locally once startup completes.
			// This keeps workspace switches and cold scoped reads to one useful round trip instead of
			// serialising "open PGlite -> download a generic shape -> run the actual query".
			if (local && getClientSync()) {
				const localResult = await local();
				if (localResult !== null && localResult !== undefined) return localResult;
			}
			const value = await post<T>(path, body, signal, key);
			// Every server answer is data this device has now seen. Folding it into the replica is
			// what makes a windowed collection converge on local instead of paying the same
			// round-trip on every visit.
			absorb?.(value);
			return value;
		},
		family
	);
}

function absorbPage(collection: string, rows: unknown): void {
	const sync = getClientSync();
	if (!sync || !Array.isArray(rows)) return;
	void absorbServerRows(sync, collection, rows);
}

const findManyQueries = new RemoteQueryResourceManager<CollectionPage>();
const findFirstQueries = new RemoteQueryResourceManager<Record<string, unknown> | null>();
const findHistoryQueries = new RemoteQueryResourceManager<
	readonly CollectionRecordHistoryEntry[]
>();
const findGroupedQueries = new RemoteQueryResourceManager<
	Record<string, Record<string, unknown>[]>
>();
const countQueries = new RemoteQueryResourceManager<number>();
const invokeQueries = new RemoteQueryResourceManager<unknown>();

function invalidateCollectionQueries(collection: string): void {
	const prefix = `db:${collection}:`;
	findManyQueries.invalidate(prefix);
	findFirstQueries.invalidate(prefix);
	findHistoryQueries.invalidate(`history:${collection}:`);
	findGroupedQueries.invalidate(prefix);
	countQueries.invalidate(prefix);
}

/** Approval actions create or roll back records in their target collection server-side,
 *  outside the db transport, so every cached collection query may be stale afterwards. */
function invalidateAllCollectionQueries(): void {
	findManyQueries.invalidate('db:');
	findFirstQueries.invalidate('db:');
	findHistoryQueries.invalidate('history:');
	findGroupedQueries.invalidate('db:');
	countQueries.invalidate('db:');
}

type ApprovalSyncReceipt = {
	readonly sync_sequence?: unknown;
	readonly approval_request?: unknown;
	readonly affected_record?: unknown;
};

/**
 * Approval commands commit outside `sync/mutate`, so their HTTP response carries an outbox
 * watermark. Do not resolve the UI action until the local replica has crossed that watermark.
 * If a damaged/blocked stream misses the bounded wait, reconcile the root record with one
 * authoritative point read; this avoids both a global refetch and a stale command result.
 */
async function settleApprovalSync(receipt: unknown): Promise<void> {
	const sync = getClientSync();
	if (!sync) return;
	const parsed =
		receipt && typeof receipt === 'object' ? (receipt as ApprovalSyncReceipt) : undefined;
	const approvalRequest = parsed?.approval_request;
	if (approvalRequest && typeof approvalRequest === 'object') {
		const approvalRequestId = Reflect.get(approvalRequest, 'norbital_id');
		if (typeof approvalRequestId === 'string') {
			// A command already returned this authoritative row. Apply it before waiting behind an
			// unrelated catch-up backlog so the initiating surface has immediate read-your-command
			// consistency; the ordered feed later repeats the same idempotent upsert for other tabs.
			await reconcileServerRow(
				sync,
				'approval_request',
				approvalRequestId,
				approvalRequest as Record<string, unknown>
			);
		}
	}
	const sequence = parsed?.sync_sequence;
	if (typeof sequence === 'string' && (await sync.client.waitForSequence(sequence))) return;

	const affected = parsed?.affected_record;
	if (!affected || typeof affected !== 'object') return;
	const collection = Reflect.get(affected, 'collection');
	const id = Reflect.get(affected, 'id');
	if (typeof collection !== 'string' || typeof id !== 'string') return;
	const row = await post<Record<string, unknown> | null>('collections/findFirst', {
		collection,
		where: { norbital_id: { eq: id } }
	});
	await reconcileServerRow(sync, collection, id, row);
}

async function settleAgentStartSync(receipt: {
	readonly chatId: string;
	readonly session?: Record<string, unknown>;
	readonly syncSequence?: string;
}): Promise<void> {
	const sync = getClientSync();
	if (!sync) return;
	if (receipt.session) {
		await reconcileServerRow(sync, 'chat_session', receipt.chatId, receipt.session);
	}
	if (receipt.syncSequence) {
		void sync.client.waitForSequence(receipt.syncSequence, { timeoutMs: 30_000 });
	}
}

/**
 * A normal collection mutation can also restart an approval request (the requestor revising a
 * record after changes were requested). The confirmed mutation row names that request, but the
 * request itself is a transaction side effect and is not part of the optimistic row result.
 * Reconcile that one authoritative row before returning so the initiating detail has
 * read-your-mutation consistency even while its live stream is catching up through older events.
 */
async function settleMutationApprovalSync(
	sync: NonNullable<ReturnType<typeof getClientSync>>,
	row: Record<string, unknown>
): Promise<void> {
	const approvalRequestId = Reflect.get(row, 'norbital_approval_id');
	if (typeof approvalRequestId !== 'string') return;
	const approvalRequest = await post<Record<string, unknown> | null>('collections/findFirst', {
		collection: 'approval_request',
		where: { norbital_id: { eq: approvalRequestId } }
	});
	await reconcileServerRow(sync, 'approval_request', approvalRequestId, approvalRequest);
}

// Client-sync (when active) drives reactive invalidation through the same seam: a diff applied to
// the local replica re-fires exactly the cached reads for that collection.
setSyncInvalidator(invalidateCollectionQueries);
// And once, when a replica opens on a device that had none: those reads answered from the server
// before there was anywhere local to register, so re-running them is what puts the page on the
// stream at all. See `announceClientSyncReady`.
setSyncReadyInvalidator(invalidateAllCollectionQueries);

const PKEY = 'norbital_id';

/** Route a write through the authoritative /_runtime/sync/mutate path; throw with the rejection
 *  reason (CONFLICT etc.) + currentRow so the form layer can reconcile.
 *
 *  The thrown `message` is what the user ends up reading — CollectionForm renders it as the form's
 *  alert — so it carries the server's own explanation when there is one, and the reason code only
 *  when there is not. `code` keeps the machine-readable reason either way. */
async function runSyncMutation(
	collection: string,
	action: WireMutation['action'],
	row: Record<string, unknown>,
	version?: number
): Promise<Record<string, unknown>> {
	const sync = getClientSync();
	if (!sync) throw new Error('client-sync is not active');
	const [result] = await syncMutate(sync, [
		{ clientId: crypto.randomUUID(), collection, action, row, version }
	]);
	if (!result || result.status === 'rejected') {
		const rejection = result?.status === 'rejected' ? result : undefined;
		const err = new Error(mutationRejectionMessage(rejection)) as Error & {
			code?: string;
			currentRow?: unknown;
		};
		err.code = rejection?.reason ?? 'MUTATE_FAILED';
		if (rejection?.currentRow) err.currentRow = rejection.currentRow;
		throw err;
	}
	if (result.row) {
		// The mutation is already committed. A failed consistency assist must not report the write as
		// failed; the ordered feed remains the convergence path for this tab and every other device.
		await settleMutationApprovalSync(sync, result.row).catch(() => undefined);
	}
	return result.row ?? {};
}

const transport: WorkspaceRemoteTransport = {
	db: {
		findMany: (input) =>
			query<CollectionPage>(
				findManyQueries,
				`db:${input.collection}:`,
				'collections/findMany',
				input,
				() => localFindMany(getClientSync()!, input.collection, input),
				(page) => absorbPage(input.collection, page?.rows)
			),
		findFirst: (input) => {
			const result = query<Record<string, unknown> | null>(
				findFirstQueries,
				`db:${input.collection}:`,
				'collections/findFirst',
				input,
				() => localFindFirst(getClientSync()!, input.collection, input),
				(row) => absorbPage(input.collection, row ? [row] : [])
			);
			return {
				get current() {
					return result.current ?? undefined;
				},
				get loading() {
					return result.loading;
				},
				get error() {
					return result.error;
				},
				refresh: () => result.refresh()
			};
		},
		findHistory: (input) =>
			query<readonly CollectionRecordHistoryEntry[]>(
				findHistoryQueries,
				`history:${input.collection}:`,
				'collections/findHistory',
				input
			),
		findGrouped: (input) =>
			query<Record<string, Record<string, unknown>[]>>(
				findGroupedQueries,
				`db:${input.collection}:`,
				'collections/findGrouped',
				input
			),
		count: (input) =>
			query<number>(countQueries, `db:${input.collection}:`, 'collections/count', input, () =>
				localCount(getClientSync()!, input.collection, input)
			),
		create: async (input) => {
			const sync = await clientSyncReady();
			if (sync) return runSyncMutation(input.collection, 'create', input.input);
			const result = await post<Record<string, unknown>>('collections/create', input);
			invalidateCollectionQueries(input.collection);
			return result;
		},
		createMany: async (input) => {
			const result = await post<Record<string, unknown>[]>('collections/createMany', input);
			invalidateCollectionQueries(input.collection);
			return result;
		},
		update: async (input) => {
			const sync = await clientSyncReady();
			if (sync) {
				const version = await sync.client.localVersion(input.collection, input.record_id);
				return runSyncMutation(
					input.collection,
					'update',
					{ [PKEY]: input.record_id, ...input.input },
					version ?? undefined
				);
			}
			const result = await post<Record<string, unknown>>('collections/update', input);
			invalidateCollectionQueries(input.collection);
			return result;
		},
		updateMany: async (input) => {
			const result = await post<Record<string, unknown>[]>('collections/updateMany', input);
			invalidateCollectionQueries(input.collection);
			return result;
		},
		delete: async (input) => {
			const sync = await clientSyncReady();
			if (sync) {
				await runSyncMutation(input.collection, 'delete', { [PKEY]: input.record_id });
				return;
			}
			await post<void>('collections/deleteRecord', input);
			invalidateCollectionQueries(input.collection);
		}
	},
	invokeCommand: (input) => post('invoke/command', input),
	invokeQuery: (input) => query(invokeQueries, 'invoke:', 'invoke/query', input),
	exportPipeline: (input) => post('collections/export', input),
	importPipeline: (input) => post('collections/import', input),
	agentChat: (input) =>
		post<{ runId: string; chatId: string | null; text: string }>('remotes/agentChat', input),
	agentChatStart: async (input) => {
		const receipt = await post<{
			runId: string;
			chatId: string;
			accepted: true;
			session?: Record<string, unknown>;
			syncSequence?: string;
		}>('remotes/agentChatStart', input);
		await settleAgentStartSync(receipt);
		return receipt;
	},
	agentModels: () =>
		post<Awaited<ReturnType<PodRemoteOperations['agentModels']>>>('remotes/agentModels', {}),
	autocompleteGeolocation: (input) =>
		post<TGeolocation[]>('remotes/autocompleteGeolocation', input),
	renderStaticMap: (input) => post('remotes/renderStaticMap', input),
	processApprovalRequestAction: (input) => post('remotes/processApprovalRequestAction', input),
	withdrawApprovalRequest: (input) => post('remotes/withdrawApprovalRequest', input)
};

export const workspaceRuntimeOperations = transport;

function collectionApi(collection: string) {
	return {
		count: (input: RemotePayload = {}) => transport.db.count({ collection, ...input }),
		create: (input: RemotePayload) => transport.db.create({ collection, input }),
		createMany: (inputs: RemotePayload[]) => transport.db.createMany({ collection, inputs }),
		update: (record_id: string, input: RemotePayload) =>
			transport.db.update({ collection, record_id, input }),
		updateMany: (updates: { record_id: string; input: RemotePayload }[]) =>
			transport.db.updateMany?.({ collection, updates }),
		delete: (record_id: string) => transport.db.delete({ collection, record_id })
	};
}

function collectionQueryApi(collection: string) {
	return {
		findMany: (input: RemotePayload = {}) =>
			collectionPageRows(transport.db.findMany({ collection, ...input })),
		findFirst: (input: RemotePayload = {}) => transport.db.findFirst({ collection, ...input })
	};
}

function approvalRequests(
	approvalRequestId: string
): RemoteQuery<readonly CollectionApprovalRequest[]> {
	const query = transport.db.findMany({
		collection: 'approval_request',
		where: { norbital_id: approvalRequestId },
		limit: 1
	});
	return {
		get current() {
			return query.current?.rows.flatMap((record) => {
				const norbitalId = record.norbital_id;
				const status = record.status;
				return typeof norbitalId === 'string' && typeof status === 'string'
					? [{ norbital_id: norbitalId, status }]
					: [];
			});
		},
		get loading() {
			return query.loading;
		},
		get error() {
			return query.error;
		},
		refresh: () => query.refresh()
	};
}

export type WorkspaceApiProxy = {
	readonly db: object;
	readonly invoke: object;
};

export type WorkspaceCollectionColumns = Readonly<Record<string, CollectionColumnMap>>;
export type WorkspaceCollectionClient<TCollections extends CollectionRegistry> =
	CollectionClient<TCollections>;

let initializedWorkspaceClient: CollectionClient<ErasedCollectionRegistry> | undefined;

export function getInitializedWorkspaceClient(): CollectionClient<ErasedCollectionRegistry> {
	if (!initializedWorkspaceClient) {
		throw new Error('Pod client used before workspace initialization');
	}
	return initializedWorkspaceClient;
}

const SYSTEM_COLLECTION_COLUMNS: CollectionColumnMap = Object.fromEntries(
	implicitQuerySystemColumnSpecs().map((field) => [
		field.name,
		{ dataType: field.kindName, notNull: !field.nullable }
	])
);

export function createWorkspaceApiProxy<
	S extends AnySchema,
	TInvoke extends InvokeMap
>(): WorkspaceClient<S, TInvoke>;
export function createWorkspaceApiProxy(): WorkspaceApiProxy {
	setWorkspaceRemoteTransport(transport);
	const queryApi = new Proxy(
		{},
		{ get: (_target, collection: string) => collectionQueryApi(collection) }
	);
	return {
		db: new Proxy(
			{},
			{
				get: (_target, property: string) =>
					property === 'query' ? queryApi : collectionApi(property)
			}
		),
		invoke: new Proxy(
			{},
			{
				get: (_target, name: string) => (payload: unknown) =>
					query(invokeQueries, 'invoke:', 'invoke', { name, payload })
			}
		)
	};
}

export function createWorkspaceCollectionClient<TCollections extends CollectionRegistry>(
	columns: WorkspaceCollectionColumns,
	manifest: NorbitalManifest
): WorkspaceCollectionClient<TCollections>;
export function createWorkspaceCollectionClient(
	columns: WorkspaceCollectionColumns,
	manifest: NorbitalManifest
): CollectionClient<ErasedCollectionRegistry> {
	setWorkspaceRemoteTransport(transport);
	const collections: Record<string, CollectionDefinition> = {};
	for (const [collectionName, collectionColumns] of Object.entries(columns)) {
		const metadata = manifest.collections[collectionName];
		const clientColumns = { ...collectionColumns, ...SYSTEM_COLLECTION_COLUMNS };
		const relationships = Object.values(manifest.relationships).flatMap((relationship) => {
			if (relationship.from === collectionName) {
				return [
					{
						name: relationship.name,
						target: relationship.to,
						cardinality: relationship.to_is_array ? ('many' as const) : ('one' as const)
					}
				];
			}
			if (relationship.to === collectionName) {
				return [
					{
						name: relationship.name,
						target: relationship.from,
						cardinality: relationship.from_is_array ? ('many' as const) : ('one' as const)
					}
				];
			}
			return [];
		});
		const directRelationships = Object.values(manifest.relationships).filter(
			(relationship) => relationship.from === collectionName && !relationship.to_is_array
		);
		collections[collectionName] = {
			name: collectionName,
			recordLabel: metadata?.record_label ?? null,
			relationships,
			fields: Object.entries(clientColumns).map(([fieldName, column]) => {
				const relationship = directRelationships.find(
					(candidate) => candidate.from_fields?.[0] === fieldName
				);
				return {
					name: fieldName,
					kind: column.dataType,
					nullable: !column.notNull,
					readOnly: fieldName.startsWith('norbital_'),
					...(column.array ? { array: true } : {}),
					...(column.values ? { values: column.values } : {}),
					...(column.options ? { options: column.options } : {}),
					...(column.currencies ? { currencies: column.currencies } : {}),
					...(column.mimeTypes ? { mimeTypes: column.mimeTypes } : {}),
					...(column.variant ? { variant: column.variant } : {}),
					...(relationship
						? {
								relation: {
									name: relationship.name,
									target: relationship.to
								}
							}
						: {})
				};
			})
		};
	}
	publishLocalSchema(collections, manifest);
	return createCollectionClient(collections, transport.db, {
		approvals: {
			findMany: approvalRequests,
			process: async ({ approvalRequestId, action, comments }) => {
				const receipt = await transport.processApprovalRequestAction({
					approval_request_id: approvalRequestId,
					action,
					comments: comments ?? null,
					isSupercede: false
				});
				await settleApprovalSync(receipt);
				invalidateAllCollectionQueries();
			},
			withdraw: async (approvalRequestId) => {
				const receipt = await transport.withdrawApprovalRequest({
					approval_request_id: approvalRequestId
				});
				await settleApprovalSync(receipt);
				invalidateAllCollectionQueries();
			}
		}
	});
}

/**
 * Hand the local query executor the schema facts it needs to compile relations, search and
 * relation-path filters into local SQL: which columns exist, which are searchable, and how
 * collections join. All of it is already in the manifest the runtime has in hand, so the client
 * never needs a round-trip to learn the shape of the data.
 *
 * Only *direct* relationships (a real foreign key on one side) are published — a through/join
 * relationship has no single join field to compile against, so the local executor declines those
 * queries and the server answers them.
 */
function publishLocalSchema(
	collections: Record<string, CollectionDefinition>,
	manifest: NorbitalManifest
): void {
	const schema = new Map<string, LocalCollectionSchema>();

	for (const [name, definition] of Object.entries(collections)) {
		const relationships = Object.values(manifest.relationships).flatMap((relationship) => {
			const fromField = relationship.from_fields?.[0];
			const toField = relationship.to_fields?.[0];
			if (!fromField || !toField) return [];
			if (relationship.from === name) {
				return [
					{
						name: relationship.name,
						target: relationship.to,
						cardinality: relationship.to_is_array ? ('many' as const) : ('one' as const),
						localField: fromField,
						targetField: toField
					}
				];
			}
			if (relationship.to === name) {
				return [
					{
						name: relationship.name,
						target: relationship.from,
						cardinality: relationship.from_is_array ? ('many' as const) : ('one' as const),
						localField: toField,
						targetField: fromField
					}
				];
			}
			return [];
		});

		schema.set(name, {
			name,
			columns: definition.fields.map((field) => field.name),
			fieldKinds: Object.fromEntries(definition.fields.map((field) => [field.name, field.kind])),
			searchFields: definition.fields
				.filter((field) => isSearchableCollectionField(field))
				.map((field) => field.name),
			relationships
		});
	}

	setLocalSchema(schema);
}

export function initializeWorkspaceClient(
	columns: WorkspaceCollectionColumns,
	manifest: NorbitalManifest
): CollectionClient<ErasedCollectionRegistry> {
	initializedWorkspaceClient = createWorkspaceCollectionClient(columns, manifest);
	return initializedWorkspaceClient;
}
