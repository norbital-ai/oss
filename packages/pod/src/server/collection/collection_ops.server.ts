import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import { typeGuard } from '@norbital-ai/std/schema';
import { NorbitalDBRecordSchema, type TNorbitalDBRecord } from './norbital_db_record.js';
import type { CollectionFilter } from '@norbital-ai/platform-utils/collection';
import type {
	CollectionFindFirstQuery,
	CollectionGroupedQuery,
	CollectionQuery
} from '$lib/authoring/workspace/db-api.js';
import { getElevatedAfterHookApi, getHookApi } from './hook-api-context.server.js';
import {
	getWorkspaceCollection,
	collectionHooks,
	allowsMutation
} from './workspace-collections.js';
import { sendAuditEvent, sendAuditEvents } from '$lib/server/audit_event.server.js';
import { v7 } from 'uuid';
import { and, eq, getColumns, inArray, sql, type AnyRelationsFilter } from 'drizzle-orm';
import { toRelationsFilter } from '$lib/authoring/workspace/relations-filter.js';
import { compilePolicyWhere } from './access_control/policy_sql.server.js';
import {
	autoResolveApprovalRequest,
	authorizeApprovalRequestRevision,
	createApprovalRequestForGatedWrite,
	findApprovalConfigInWorkspace,
	loadApprovalRequestRow,
	restartApprovalRequestForRevision
} from './access_control/approval_service.server.js';
import type {
	TCollectionActionContext,
	TResolvedApprovalConfig
} from './access_control/approval_scope_types.js';
import {
	resolveCollectionMutationPermission,
	resolveCollectionReadPermission,
	selfServiceWriteAllowed,
	SELF_SERVICE_WRITE_COLLECTIONS
} from './access_control/permission/collection_permission.guard.server.js';
import { error } from './http_error.js';
import { requestI18nOrDefault } from '$lib/server/i18n.js';
import { withConstraintErrors } from './constraint-errors.server.js';
import { getCurrentPermissionBypassKey } from './access_control/permission/permission_bypass_key.server.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import {
	collectionMetadata,
	directFindMany,
	directRelationalFindFirst,
	directFindFirst,
	directCount,
	directFindGrouped,
	directInsert,
	directUpdate,
	directDelete,
	flattenWithOntoPayload,
	parseMutationInput,
	mergeWhere,
	splitMutationPayload,
	persistMutationRelationships,
	firstRowAsRecord,
	requireTable,
	getCollectionQuery
} from './collection_direct.js';
import {
	emitOutboundRows,
	emitOutboundRowsMany
} from '$lib/server/integrations/tenant-outbox.server.js';
import { emitSyncOutbox, emitSyncOutboxMany } from './sync/sync-outbox.server.js';
import { withCollectionTransaction, withMutationDb } from './collection_transaction.server.js';
import { collectionFiltersWhere } from './collection_filters.server.js';
import { collectionSearchWhere } from './collection_search.server.js';
import {
	collectionCursorWhere,
	encodeCollectionCursor,
	normalizeCursorOrder,
	type CursorOrder
} from './collection_cursor.server.js';

export interface CollectionPageResult {
	readonly rows: Record<string, unknown>[];
	readonly nextCursor: string | null;
}

function cursorQueryColumns(
	columns: Readonly<Record<string, boolean | undefined>> | undefined,
	orderBy: CursorOrder
): { readonly columns: Record<string, boolean> | undefined; readonly injected: readonly string[] } {
	if (!columns) return { columns: undefined, injected: [] };
	const inclusionMode = Object.values(columns).some(Boolean);
	const result = Object.fromEntries(
		Object.entries(columns).filter((entry): entry is [string, boolean] => entry[1] !== undefined)
	);
	const injected: string[] = [];
	for (const field of Object.keys(orderBy)) {
		if (result[field] === true) continue;
		if (inclusionMode) {
			result[field] = true;
			injected.push(field);
		} else if (result[field] === false) {
			delete result[field];
			injected.push(field);
		}
	}
	return { columns: result, injected };
}

function removeInjectedCursorColumns(
	rows: readonly Record<string, unknown>[],
	injected: readonly string[]
): Record<string, unknown>[] {
	if (injected.length === 0) return [...rows];
	return rows.map((row) => {
		const projected = { ...row };
		for (const field of injected) delete projected[field];
		return projected;
	});
}

async function resolvePolicyWhere(
	ctx: ProvisionedContext,
	collectionName: string
): Promise<AnyRelationsFilter | undefined> {
	const metadata = collectionMetadata(ctx, collectionName);
	const readScope = await resolveCollectionReadPermission({
		approvalServiceBypassKey: getCurrentPermissionBypassKey(),
		collectionMetadata: metadata,
		context: {
			type: 'list',
			scope: { ...ctx.baseScope, records: null }
		}
	});

	return compilePolicyWhere(readScope.reducedCondition ?? null, ctx.baseScope) ?? undefined;
}

export async function findMany(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionQuery,
	filters?: readonly CollectionFilter[]
): Promise<Record<string, unknown>[]> {
	if (!ctx.baseScope) {
		throw new Error(`Collection query for '${collection}' requires base scope`);
	}

	const policyWhere = await resolvePolicyWhere(ctx, collection);
	const where = mergeWhere(
		mergeWhere(
			mergeWhere(policyWhere, query.where),
			collectionFiltersWhere(ctx, collection, filters)
		),
		collectionSearchWhere(ctx, collection, query.search)
	);

	return directFindMany(ctx, collection, { ...query, where });
}

/** Policy-aware keyset page used by the public collection client. */
export async function findManyPage(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionQuery & { readonly after?: string },
	filters?: readonly CollectionFilter[]
): Promise<CollectionPageResult> {
	const { after, ...baseQuery } = query;
	const orderBy = normalizeCursorOrder(baseQuery.orderBy as CursorOrder | undefined);
	const where = mergeWhere(baseQuery.where, collectionCursorWhere(after, orderBy));
	const requestedLimit = typeof baseQuery.limit === 'number' ? baseQuery.limit : 100;
	const limit = Math.min(5000, Math.max(1, requestedLimit));
	const cursorColumns = cursorQueryColumns(baseQuery.columns, orderBy);
	const rows = await findMany(
		ctx,
		collection,
		{
			...baseQuery,
			where,
			orderBy,
			columns: cursorColumns.columns,
			limit: limit + 1
		},
		filters
	);
	const hasNextPage = rows.length > limit;
	const cursorRows = hasNextPage ? rows.slice(0, limit) : rows;
	return {
		rows: removeInjectedCursorColumns(cursorRows, cursorColumns.injected),
		nextCursor:
			hasNextPage && cursorRows.length > 0
				? encodeCollectionCursor(cursorRows[cursorRows.length - 1]!, orderBy)
				: null
	};
}

export async function findFirst(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionFindFirstQuery
): Promise<Record<string, unknown> | undefined> {
	if (!ctx.baseScope) {
		throw new Error(`Collection query for '${collection}' requires base scope`);
	}

	const policyWhere = await resolvePolicyWhere(ctx, collection);
	const where = mergeWhere(
		mergeWhere(policyWhere, query.where),
		collectionSearchWhere(ctx, collection, query.search)
	);

	return directRelationalFindFirst(ctx, collection, { ...query, where });
}

/** Exact row count for the policy-merged collection query. */
export async function countRecords(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionQuery,
	filters?: readonly CollectionFilter[]
): Promise<number> {
	const policyWhere = await resolvePolicyWhere(ctx, collection);
	const where = mergeWhere(
		mergeWhere(
			mergeWhere(policyWhere, query.where),
			collectionFiltersWhere(ctx, collection, filters)
		),
		collectionSearchWhere(ctx, collection, query.search)
	);
	return directCount(ctx, collection, { ...query, where });
}

export async function findGrouped(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionGroupedQuery,
	filters?: readonly CollectionFilter[]
): Promise<Record<string, Record<string, unknown>[]>> {
	const requestedLimit = typeof query.limit === 'number' ? query.limit : 100;
	const limit = Math.min(5000, Math.max(1, requestedLimit));
	const policyWhere = await resolvePolicyWhere(ctx, collection);
	const baseWhere = mergeWhere(
		mergeWhere(
			mergeWhere(policyWhere, query.where),
			collectionFiltersWhere(ctx, collection, filters)
		),
		collectionSearchWhere(ctx, collection, query.search)
	);
	return directFindGrouped(ctx, collection, { ...query, where: baseWhere, limit });
}

export function createRecord(
	ctx: ProvisionedContext,
	collection: string,
	input: Record<string, unknown>,
	options?: { isElevated?: boolean; recordId?: string }
): Promise<Record<string, unknown>> {
	return withConstraintErrors(collection, () =>
		createRecordUnguarded(ctx, collection, input, options)
	);
}

async function createRecordUnguarded(
	ctx: ProvisionedContext,
	collection: string,
	input: Record<string, unknown>,
	options?: { isElevated?: boolean; recordId?: string }
): Promise<Record<string, unknown>> {
	const behavior = getWorkspaceCollection(collection);
	if (!options?.isElevated && !allowsMutation(behavior, 'create')) {
		throw error(403, requestI18nOrDefault().t('pod.server.createNotAllowed', { collection }));
	}

	const api = await getHookApi();
	let payload = flattenWithOntoPayload(parseMutationInput(collection, 'create', input));
	const beforeHook = collectionHooks(behavior, 'create')?.before;
	if (beforeHook) {
		const hookResult = await beforeHook({ input, api });
		if (hookResult != null) {
			payload = hookResult;
		}
	}
	if (options?.recordId) payload[SYSTEM_COLUMN_NAMES.PKEY] = options.recordId;

	const metadata = collectionMetadata(ctx, collection);
	const mutationContext = {
		type: 'create' as const,
		payload,
		scope: { ...ctx.baseScope, incoming_record: payload }
	};

	let gatedConfig: TResolvedApprovalConfig | null = null;
	if (!options?.isElevated) {
		const decision = await resolveCollectionMutationPermission({
			scope: {
				approvalServiceBypassKey: getCurrentPermissionBypassKey(),
				collectionMetadata: metadata,
				context: mutationContext
			},
			actionType: 'create'
		});
		gatedConfig = decision.approvalConfig ?? null;
	}

	const { row, links, nested } = splitMutationPayload(ctx, collection, payload);
	const now = new Date().toISOString();
	const approvalRequestId = gatedConfig ? v7() : undefined;
	const table = requireTable(ctx, collection);
	const afterHook = collectionHooks(behavior, 'create')?.after;
	const created = await withCollectionTransaction(ctx, async () => {
		const record = await withMutationDb(ctx, async (db) => {
			const inserted = firstRowAsRecord(
				await db
					.insert(table)
					.values({
						...row,
						[SYSTEM_COLUMN_NAMES.CREATED_AT]: row[SYSTEM_COLUMN_NAMES.CREATED_AT] ?? now,
						[SYSTEM_COLUMN_NAMES.UPDATED_AT]: row[SYSTEM_COLUMN_NAMES.UPDATED_AT] ?? now,
						...(approvalRequestId ? { [SYSTEM_COLUMN_NAMES.APPROVAL_ID]: approvalRequestId } : {})
					})
					.returning()
			);
			if (inserted) {
				await emitOutboundRows(db, ctx, collection, 'create', inserted);
				await emitSyncOutbox(db, collection, 'create', inserted);
			}
			return inserted;
		});

		if (!record) throw error(500, `Failed to create record in "${collection}"`);
		const sourceId = String(record[SYSTEM_COLUMN_NAMES.PKEY] ?? '');
		await persistMutationRelationships(ctx, collection, sourceId, links, nested);

		if (gatedConfig && approvalRequestId) {
			await createApprovalRequestForGatedWrite({
				approvalConfig: gatedConfig,
				collectionName: collection,
				context: mutationContext,
				rootRecord: record,
				lockType: 'record_mutation',
				requestId: approvalRequestId
			});
		}
		if (afterHook) await afterHook({ record, api: await getElevatedAfterHookApi() });
		await sendAuditEvent(
			collection,
			{
				action: 'record.create',
				entityType: collection,
				entityId: sourceId || collection,
				changesAfter: record
			},
			'create'
		);
		return record;
	});

	return created;
}

export function createMany(
	ctx: ProvisionedContext,
	collection: string,
	inputs: readonly Record<string, unknown>[],
	options?: { isElevated?: boolean }
): Promise<Record<string, unknown>[]> {
	return withConstraintErrors(collection, () =>
		createManyUnguarded(ctx, collection, inputs, options)
	);
}

async function createManyUnguarded(
	ctx: ProvisionedContext,
	collection: string,
	inputs: readonly Record<string, unknown>[],
	options?: { isElevated?: boolean }
): Promise<Record<string, unknown>[]> {
	if (inputs.length === 0) return [];
	const behavior = getWorkspaceCollection(collection);
	if (!options?.isElevated && !allowsMutation(behavior, 'create')) {
		throw error(403, requestI18nOrDefault().t('pod.server.createNotAllowed', { collection }));
	}

	const api = await getHookApi();
	const beforeHook = collectionHooks(behavior, 'create')?.before;
	const afterHook = collectionHooks(behavior, 'create')?.after;
	const metadata = collectionMetadata(ctx, collection);
	const table = requireTable(ctx, collection);
	const now = new Date().toISOString();
	const records = await withCollectionTransaction(ctx, async () => {
		const prepared: Array<{
			values: Record<string, unknown>;
			links: Record<string, string[]>;
			nested: Record<string, Record<string, unknown>[]>;
			approvalRequestId?: string;
			gatedConfig: TResolvedApprovalConfig | null;
			mutationContext: Extract<TCollectionActionContext, { type: 'create' }>;
		}> = [];

		// stupidity:allow A6 -- hooks and permission checks run in caller order within one transaction.
		for (const input of inputs) {
			let payload = flattenWithOntoPayload(parseMutationInput(collection, 'create', input));
			if (beforeHook) {
				const hookResult = await beforeHook({ input, api });
				if (hookResult != null) payload = hookResult;
			}

			const mutationContext = {
				type: 'create' as const,
				payload,
				scope: { ...ctx.baseScope, incoming_record: payload }
			};
			let gatedConfig: TResolvedApprovalConfig | null = null;
			if (!options?.isElevated) {
				const decision = await resolveCollectionMutationPermission({
					scope: {
						approvalServiceBypassKey: getCurrentPermissionBypassKey(),
						collectionMetadata: metadata,
						context: mutationContext
					},
					actionType: 'create'
				});
				gatedConfig = decision.approvalConfig ?? null;
			}

			const { row, links, nested } = splitMutationPayload(ctx, collection, payload);
			const approvalRequestId = gatedConfig ? v7() : undefined;
			prepared.push({
				values: {
					...row,
					[SYSTEM_COLUMN_NAMES.CREATED_AT]: row[SYSTEM_COLUMN_NAMES.CREATED_AT] ?? now,
					[SYSTEM_COLUMN_NAMES.UPDATED_AT]: row[SYSTEM_COLUMN_NAMES.UPDATED_AT] ?? now,
					...(approvalRequestId ? { [SYSTEM_COLUMN_NAMES.APPROVAL_ID]: approvalRequestId } : {})
				},
				links,
				nested,
				approvalRequestId,
				gatedConfig,
				mutationContext
			});
		}

		const created = await withMutationDb(ctx, async (db) => {
			const rows = await db
				.insert(table)
				.values(prepared.map(({ values }) => values))
				.returning();
			const normalized: Record<string, unknown>[] = [];
			for (const row of rows) {
				const record = firstRowAsRecord([row]);
				if (!record) throw error(500, `Failed to create a record in "${collection}"`);
				normalized.push(record);
			}
			// stupidity:allow A6 -- outbox writes share the mutation transaction connection.
			for (const record of normalized) {
				await emitOutboundRows(db, ctx, collection, 'create', record);
			}
			// The batch was inserted with one statement, so its change-feed rows go the same way.
			// Per row this was one network round trip each, which on a remote database made the
			// feed — not the data — the cost of every bulk write.
			await emitSyncOutboxMany(db, collection, 'create', normalized);
			return normalized;
		});
		if (created.length !== prepared.length) {
			throw error(500, `Failed to create all records in "${collection}"`);
		}

		const afterApi = afterHook ? await getElevatedAfterHookApi() : undefined;
		// stupidity:allow A6 -- relationship, approval, and after-hook side effects preserve input order.
		for (const [index, record] of created.entries()) {
			const item = prepared[index];
			if (!item) throw error(500, `Missing prepared record in "${collection}"`);
			const sourceId = String(record[SYSTEM_COLUMN_NAMES.PKEY] ?? '');
			await persistMutationRelationships(ctx, collection, sourceId, item.links, item.nested);
			if (item.gatedConfig && item.approvalRequestId) {
				await createApprovalRequestForGatedWrite({
					approvalConfig: item.gatedConfig,
					collectionName: collection,
					context: item.mutationContext,
					rootRecord: record,
					lockType: 'record_mutation',
					requestId: item.approvalRequestId
				});
			}
			if (afterHook && afterApi) await afterHook({ record, api: afterApi });
		}

		await sendAuditEvents(
			created.map((record) => ({
				collectionName: collection,
				params: {
					action: 'record.create',
					entityType: collection,
					entityId: String(record[SYSTEM_COLUMN_NAMES.PKEY] ?? collection),
					changesAfter: record
				},
				eventLabel: 'create'
			}))
		);
		return created;
	});
	return records;
}

type ApprovalRevisionPlan = {
	approvalRequestId: string;
	approvalConfig: TResolvedApprovalConfig | null;
	approvalContext: Extract<TCollectionActionContext, { type: 'create' | 'update' }>;
};

async function resolveApprovalRevision(params: {
	ctx: ProvisionedContext;
	collection: string;
	metadata: ReturnType<typeof collectionMetadata>;
	originalRecord: Record<string, unknown>;
	payload: Record<string, unknown>;
	updateContext: Extract<TCollectionActionContext, { type: 'update' }>;
}): Promise<ApprovalRevisionPlan | null> {
	const { ctx, collection, metadata, originalRecord, payload, updateContext } = params;
	const approvalRequestId = originalRecord[SYSTEM_COLUMN_NAMES.APPROVAL_ID];
	if (typeof approvalRequestId !== 'string' || approvalRequestId.length === 0) return null;

	const approvalRequest = await loadApprovalRequestRow(approvalRequestId);
	if (!approvalRequest || approvalRequest.collection_name !== collection) {
		throw error(409, requestI18nOrDefault().t('pod.server.approvalUnavailable'));
	}
	const configuredApproval = await findApprovalConfigInWorkspace(
		ctx.manifestCtx,
		approvalRequest.approval_config_id
	);
	if (
		!configuredApproval ||
		(configuredApproval.actionType !== 'create' && configuredApproval.actionType !== 'update')
	) {
		throw error(409, requestI18nOrDefault().t('pod.server.approvalWorkflowUnavailable'));
	}

	const approvalContext =
		configuredApproval.actionType === 'create'
			? ({
					type: 'create',
					payload: { ...originalRecord, ...payload },
					scope: {
						...ctx.baseScope,
						incoming_record: { ...originalRecord, ...payload }
					}
				} satisfies Extract<TCollectionActionContext, { type: 'create' }>)
			: updateContext;
	const decision = await resolveCollectionMutationPermission({
		scope: {
			approvalServiceBypassKey: getCurrentPermissionBypassKey(),
			collectionMetadata: metadata,
			context: approvalContext
		},
		actionType: configuredApproval.actionType
	});

	return {
		approvalRequestId,
		approvalConfig: decision.approvalConfig ?? null,
		approvalContext
	};
}

export function updateRecord(
	ctx: ProvisionedContext,
	collection: string,
	recordId: string,
	input: Record<string, unknown>,
	options?: { isElevated?: boolean; expectedVersion?: number }
): Promise<Record<string, unknown>> {
	return withConstraintErrors(collection, () =>
		updateRecordUnguarded(ctx, collection, recordId, input, options)
	);
}

async function updateRecordUnguarded(
	ctx: ProvisionedContext,
	collection: string,
	recordId: string,
	input: Record<string, unknown>,
	options?: { isElevated?: boolean; expectedVersion?: number }
): Promise<Record<string, unknown>> {
	const behavior = getWorkspaceCollection(collection);
	// A system collection has no author to declare it mutable, so this gate refuses one outright —
	// right for every system collection but the ones carrying a self-service write. Membership here
	// only gets the write as far as the payload being known; whether it is *the* self-service write
	// is decided below, once there is a payload and an original record to decide it against.
	const authorDeclaredMutable = allowsMutation(behavior, 'update');
	if (
		!options?.isElevated &&
		!authorDeclaredMutable &&
		!SELF_SERVICE_WRITE_COLLECTIONS.has(collection)
	) {
		throw error(403, requestI18nOrDefault().t('pod.server.updateNotAllowed', { collection }));
	}

	const api = await getHookApi();
	const originalRecord = await directFindFirst(ctx, collection, recordId);
	const parsedInput = parseMutationInput(collection, 'update', input);
	let payload = {
		...flattenWithOntoPayload(parsedInput),
		[SYSTEM_COLUMN_NAMES.PKEY]: recordId
	};

	const beforeHook = collectionHooks(behavior, 'update')?.before;
	if (beforeHook) {
		const hookResult = await beforeHook({
			input: parsedInput,
			existing: originalRecord,
			api
		});
		payload = {
			...(hookResult ?? {}),
			[SYSTEM_COLUMN_NAMES.PKEY]: recordId
		};
	}

	const metadata = collectionMetadata(ctx, collection);
	const mutationContext = {
		type: 'update' as const,
		payload,
		scope: {
			...ctx.baseScope,
			incoming_record: payload,
			original_record: originalRecord
		}
	};

	let gatedConfig: TResolvedApprovalConfig | null = null;
	if (!options?.isElevated) {
		// An undeclared collection got this far only because it carries a self-service write. This is
		// where that claim is tested — including for an admin, whose role short-circuits the policy
		// deny but does not turn a notification into an editable record.
		if (!authorDeclaredMutable && !selfServiceWriteAllowed(collection, 'update', mutationContext)) {
			throw error(403, requestI18nOrDefault().t('pod.server.updateNotAllowed', { collection }));
		}
		const decision = await resolveCollectionMutationPermission({
			scope: {
				approvalServiceBypassKey: getCurrentPermissionBypassKey(),
				collectionMetadata: metadata,
				context: mutationContext
			},
			actionType: 'update'
		});
		gatedConfig = decision.approvalConfig ?? null;
	}
	const revision = await resolveApprovalRevision({
		ctx,
		collection,
		metadata,
		originalRecord,
		payload,
		updateContext: mutationContext
	});

	const { row, links, nested } = splitMutationPayload(ctx, collection, payload);
	const approvalRequestId = !revision && gatedConfig ? v7() : undefined;
	const activeApprovalRequestId = revision?.approvalRequestId ?? approvalRequestId;
	const table = requireTable(ctx, collection);
	const cols = getColumns(table);
	const now = new Date().toISOString();

	const updateAfterHook = collectionHooks(behavior, 'update')?.after;
	const updated = await withCollectionTransaction(ctx, async () => {
		if (revision) {
			await authorizeApprovalRequestRevision({
				approvalRequestId: revision.approvalRequestId,
				collectionName: collection,
				recordId,
				requestorId: ctx.baseScope.requestor.norbital_id
			});
		}
		const record = await withMutationDb(ctx, async (db) => {
			// The _norbital_versioning trigger owns temporal bookkeeping: it archives the prior
			// row to history, opens a fresh system period, and increments norbital_row_version
			// (the optimistic-concurrency token that lets stale writes be rejected below).
			const next = firstRowAsRecord(
				await db
					.update(table)
					.set({
						...row,
						[SYSTEM_COLUMN_NAMES.UPDATED_AT]: now,
						...(activeApprovalRequestId
							? { [SYSTEM_COLUMN_NAMES.APPROVAL_ID]: activeApprovalRequestId }
							: {})
					})
					.where(
						options?.expectedVersion === undefined
							? eq(cols[SYSTEM_COLUMN_NAMES.PKEY], recordId)
							: and(
									eq(cols[SYSTEM_COLUMN_NAMES.PKEY], recordId),
									eq(cols[SYSTEM_COLUMN_NAMES.ROW_VERSION], options.expectedVersion)
								)
					)
					.returning()
			);
			if (next) {
				await emitOutboundRows(db, ctx, collection, 'update', next, originalRecord);
				await emitSyncOutbox(db, collection, 'update', next);
			}
			return next;
		});

		if (!record) {
			// Version-guarded write matched no row: the row still exists (fetched above) but
			// its version moved on — a stale write. Reject as a conflict with current state so
			// the caller can rebase. Throwing here rolls the transaction back: zero trace.
			if (options?.expectedVersion !== undefined) {
				const current = await directFindFirst(ctx, collection, recordId).catch(() => undefined);
				if (current) {
					throw error(409, {
						message: requestI18nOrDefault().t('pod.server.recordModifiedConcurrently'),
						code: 'CONFLICT',
						currentRow: current
					});
				}
			}
			throw error(404, requestI18nOrDefault().t('pod.server.recordNotFound', { id: recordId }));
		}
		await persistMutationRelationships(ctx, collection, recordId, links, nested);

		if (revision?.approvalConfig) {
			await restartApprovalRequestForRevision({
				approvalRequestId: revision.approvalRequestId,
				approvalConfig: revision.approvalConfig,
				context: revision.approvalContext,
				rootRecord: record,
				lockType: 'record_mutation'
			});
		} else if (revision) {
			await autoResolveApprovalRequest(revision.approvalRequestId);
		} else if (gatedConfig && approvalRequestId) {
			await createApprovalRequestForGatedWrite({
				approvalConfig: gatedConfig,
				collectionName: collection,
				context: mutationContext,
				rootRecord: record,
				lockType: 'record_mutation',
				requestId: approvalRequestId
			});
		}
		if (updateAfterHook) {
			await updateAfterHook({ record, api: await getElevatedAfterHookApi() });
		}
		await sendAuditEvent(
			collection,
			{
				action: 'record.update',
				entityType: collection,
				entityId: recordId,
				changesBefore: originalRecord,
				changesAfter: record
			},
			'update'
		);
		return record;
	});

	return updated;
}

/**
 * Apply a per-record patch to many records of one collection in a single atomic
 * transaction. Each record is processed with the exact same semantics as
 * {@link updateRecord} — before/after hooks, per-record permission evaluation,
 * approval gating (write-then-lock), row versioning, outbox emission, and audit —
 * so a bulk call can never become a privilege bypass.
 *
 * Failure semantics are all-or-nothing: if any record is denied (403), already
 * locked by a pending approval (409), missing (404), or rejected by a hook, the
 * whole transaction rolls back and no record is changed. This mirrors
 * {@link createMany} and matches the existing error model, which throws rather
 * than returning per-record results.
 */
export async function updateMany(
	ctx: ProvisionedContext,
	collection: string,
	updates: readonly { recordId: string; input: Record<string, unknown> }[],
	options?: { isElevated?: boolean }
): Promise<Record<string, unknown>[]> {
	if (updates.length === 0) return [];
	const behavior = getWorkspaceCollection(collection);
	if (!options?.isElevated && !allowsMutation(behavior, 'update')) {
		throw error(403, requestI18nOrDefault().t('pod.server.updateNotAllowed', { collection }));
	}

	const api = await getHookApi();
	const beforeHook = collectionHooks(behavior, 'update')?.before;
	const afterHook = collectionHooks(behavior, 'update')?.after;
	const metadata = collectionMetadata(ctx, collection);
	const table = requireTable(ctx, collection);
	const cols = getColumns(table);
	const now = new Date().toISOString();

	const result = await withCollectionTransaction(ctx, async () => {
		const prepared: Array<{
			recordId: string;
			originalRecord: Record<string, unknown>;
			row: Record<string, unknown>;
			links: Record<string, string[]>;
			nested: Record<string, Record<string, unknown>[]>;
			approvalRequestId?: string;
			gatedConfig: TResolvedApprovalConfig | null;
			mutationContext: Extract<TCollectionActionContext, { type: 'update' }>;
			revision: ApprovalRevisionPlan | null;
		}> = [];

		// Phase 1: validate every record (hooks, pending-lock, permission) before any write, so a
		// later denial cannot leave earlier after-hook side effects behind — all-or-nothing.
		// stupidity:allow A6 -- hooks and permission checks run in caller order within one transaction.
		for (const { recordId, input } of updates) {
			const originalRecord = await directFindFirst(ctx, collection, recordId);
			const parsedInput = parseMutationInput(collection, 'update', input);
			let payload = {
				...flattenWithOntoPayload(parsedInput),
				[SYSTEM_COLUMN_NAMES.PKEY]: recordId
			};
			if (beforeHook) {
				const hookResult = await beforeHook({ input: parsedInput, existing: originalRecord, api });
				payload = {
					...(hookResult ?? {}),
					[SYSTEM_COLUMN_NAMES.PKEY]: recordId
				};
			}

			const mutationContext = {
				type: 'update' as const,
				payload,
				scope: {
					...ctx.baseScope,
					incoming_record: payload,
					original_record: originalRecord
				}
			};

			let gatedConfig: TResolvedApprovalConfig | null = null;
			if (!options?.isElevated) {
				const decision = await resolveCollectionMutationPermission({
					scope: {
						approvalServiceBypassKey: getCurrentPermissionBypassKey(),
						collectionMetadata: metadata,
						context: mutationContext
					},
					actionType: 'update'
				});
				gatedConfig = decision.approvalConfig ?? null;
			}
			const revision = await resolveApprovalRevision({
				ctx,
				collection,
				metadata,
				originalRecord,
				payload,
				updateContext: mutationContext
			});

			const { row, links, nested } = splitMutationPayload(ctx, collection, payload);
			prepared.push({
				recordId,
				originalRecord,
				row,
				links,
				nested,
				approvalRequestId: !revision && gatedConfig ? v7() : undefined,
				gatedConfig,
				mutationContext,
				revision
			});
		}

		// Phase 2: apply every row update inside one mutation transaction.
		// stupidity:allow A6 -- revision authorization takes ordered row locks and sets connection-local context.
		for (const item of prepared) {
			if (!item.revision) continue;
			await authorizeApprovalRequestRevision({
				approvalRequestId: item.revision.approvalRequestId,
				collectionName: collection,
				recordId: item.recordId,
				requestorId: ctx.baseScope.requestor.norbital_id
			});
		}
		const updated = await withMutationDb(ctx, async (db) => {
			const out: Record<string, unknown>[] = [];
			// stupidity:allow A6 -- ordered updates preserve caller order and share the mutation connection.
			for (const item of prepared) {
				const activeApprovalRequestId = item.revision?.approvalRequestId ?? item.approvalRequestId;
				// The _norbital_versioning trigger archives the prior row + bumps the version.
				const record = firstRowAsRecord(
					await db
						.update(table)
						.set({
							...item.row,
							[SYSTEM_COLUMN_NAMES.UPDATED_AT]: now,
							...(activeApprovalRequestId
								? { [SYSTEM_COLUMN_NAMES.APPROVAL_ID]: activeApprovalRequestId }
								: {})
						})
						.where(eq(cols[SYSTEM_COLUMN_NAMES.PKEY], item.recordId))
						.returning()
				);
				if (!record) throw error(404, requestI18nOrDefault().t('pod.server.recordNotFound', { id: item.recordId }));
				out.push(record);
			}
			// Each row needs its own UPDATE (different values), but the feeds do not: emitting them
			// per row doubled the round trips of every bulk update against a remote database.
			// `seq` is still assigned in caller order.
			await emitOutboundRowsMany(
				db,
				ctx,
				collection,
				'update',
				out.map((record, index) => ({ record, previous: prepared[index]?.originalRecord }))
			);
			await emitSyncOutboxMany(db, collection, 'update', out);
			return out;
		});

		// Phase 3: relationship, approval, and after-hook side effects preserve input order.
		const afterApi = afterHook ? await getElevatedAfterHookApi() : undefined;
		// stupidity:allow A6 -- side effects run only after every write succeeded.
		for (const [index, record] of updated.entries()) {
			const item = prepared[index];
			if (!item) throw error(500, `Missing prepared record in "${collection}"`);
			await persistMutationRelationships(ctx, collection, item.recordId, item.links, item.nested);
			if (item.revision?.approvalConfig) {
				await restartApprovalRequestForRevision({
					approvalRequestId: item.revision.approvalRequestId,
					approvalConfig: item.revision.approvalConfig,
					context: item.revision.approvalContext,
					rootRecord: record,
					lockType: 'record_mutation'
				});
			} else if (item.revision) {
				await autoResolveApprovalRequest(item.revision.approvalRequestId);
			} else if (item.gatedConfig && item.approvalRequestId) {
				await createApprovalRequestForGatedWrite({
					approvalConfig: item.gatedConfig,
					collectionName: collection,
					context: item.mutationContext,
					rootRecord: record,
					lockType: 'record_mutation',
					requestId: item.approvalRequestId
				});
			}
			if (afterHook && afterApi) await afterHook({ record, api: afterApi });
		}

		const audits = prepared.map((item, index) => ({
			collectionName: collection,
			params: {
				action: 'record.update' as const,
				entityType: collection,
				entityId: item.recordId,
				changesBefore: item.originalRecord,
				changesAfter: updated[index]
			},
			eventLabel: 'update'
		}));
		await sendAuditEvents(audits);
		return updated;
	});
	return result;
}

export async function deleteRecord(
	ctx: ProvisionedContext,
	collection: string,
	recordId: string,
	options?: { isElevated?: boolean }
): Promise<void> {
	await deleteMany(ctx, collection, [recordId], options);
}

/** Ids per SELECT / DELETE statement. One bind parameter each, far inside Postgres' 65,535 limit. */
const DELETE_CHUNK = 1_000;

/** Load a batch of records by id in as few statements as the batch allows. */
async function loadRecordsById(
	ctx: ProvisionedContext,
	collection: string,
	ids: readonly string[]
): Promise<Map<string, TNorbitalDBRecord>> {
	const finder = getCollectionQuery(ctx, collection);
	const byId = new Map<string, TNorbitalDBRecord>();
	for (let from = 0; from < ids.length; from += DELETE_CHUNK) {
		const chunk = ids.slice(from, from + DELETE_CHUNK);
		const rows = await finder.findMany({
			where: toRelationsFilter({ [SYSTEM_COLUMN_NAMES.PKEY]: { in: chunk } })
		});
		for (const row of rows) {
			if (typeGuard(NorbitalDBRecordSchema, row)) byId.set(row[SYSTEM_COLUMN_NAMES.PKEY], row);
		}
	}
	return byId;
}

/**
 * Delete many records of one collection in a single atomic transaction, with the same semantics
 * per record as a lone delete — before/after hooks, per-record permission evaluation, approval
 * gating, history archival, change-feed emission and audit — so a bulk call can never become a
 * privilege bypass. {@link deleteRecord} is the one-element case, so the two cannot drift.
 *
 * The saving is round trips, not guarantees. A per-record loop cost a SELECT, a DELETE, a
 * change-feed INSERT and an audit INSERT each — on a remote database roughly 18 ms apiece, which
 * made clearing a few hundred rows (a payroll rebuild deletes its previous results before every
 * build) take minutes. Records are now loaded with one SELECT per chunk, removed with one DELETE
 * per chunk, and stamped into the change feed and the audit log in one statement each. The
 * database's per-row work is untouched: `_approval_lock_gate`, `_ops_guard` and
 * `_norbital_versioning` are FOR EACH ROW triggers and still fire once per deleted row, so a
 * locked record is still rejected and every deleted row is still archived to its typed history table.
 *
 * Failure is all-or-nothing: a denied, locked, missing or hook-rejected record rolls the whole
 * transaction back, matching {@link createMany} and {@link updateMany}.
 */
export function deleteMany(
	ctx: ProvisionedContext,
	collection: string,
	ids: readonly string[],
	options?: { isElevated?: boolean }
): Promise<void> {
	return withConstraintErrors(collection, () => deleteManyUnguarded(ctx, collection, ids, options));
}

async function deleteManyUnguarded(
	ctx: ProvisionedContext,
	collection: string,
	ids: readonly string[],
	options?: { isElevated?: boolean }
): Promise<void> {
	if (ids.length === 0) return;
	const behavior = getWorkspaceCollection(collection);
	if (!options?.isElevated && !allowsMutation(behavior, 'delete')) {
		throw error(403, requestI18nOrDefault().t('pod.server.deleteNotAllowed', { collection }));
	}

	const api = await getHookApi();
	const metadata = collectionMetadata(ctx, collection);
	const beforeHook = collectionHooks(behavior, 'delete')?.before;
	const deleteAfterHook = collectionHooks(behavior, 'delete')?.after;
	const table = requireTable(ctx, collection);
	const cols = getColumns(table);

	await withCollectionTransaction(ctx, async () => {
		const originals = await loadRecordsById(ctx, collection, ids);

		type PreparedDelete = {
			recordId: string;
			originalRecord: TNorbitalDBRecord;
			mutationContext: Extract<TCollectionActionContext, { type: 'delete' }>;
			gatedConfig: TResolvedApprovalConfig | null;
			approvalRequestId?: string;
		};
		const prepared: PreparedDelete[] = [];
		const seen = new Set<string>();

		// Phase 1: validate and run every before hook in caller order, before any row is removed.
		// stupidity:allow A6 -- delete hooks and permission checks must observe caller order.
		for (const recordId of ids) {
			// A repeated id names a row this very operation already removed.
			if (seen.has(recordId)) throw error(404, requestI18nOrDefault().t('pod.server.recordNotFound', { id: recordId }));
			seen.add(recordId);
			const originalRecord = originals.get(recordId);
			if (!originalRecord) throw error(404, requestI18nOrDefault().t('pod.server.recordNotFound', { id: recordId }));

			const existingStamp = originalRecord[SYSTEM_COLUMN_NAMES.APPROVAL_ID];
			if (typeof existingStamp === 'string' && existingStamp.length > 0) {
				throw error(409, requestI18nOrDefault().t('pod.server.pendingApprovalBlocksDelete'));
			}

			const mutationContext = {
				type: 'delete' as const,
				scope: { ...ctx.baseScope, original_record: originalRecord }
			};

			let gatedConfig: TResolvedApprovalConfig | null = null;
			if (!options?.isElevated) {
				const decision = await resolveCollectionMutationPermission({
					scope: {
						approvalServiceBypassKey: getCurrentPermissionBypassKey(),
						collectionMetadata: metadata,
						context: mutationContext
					},
					actionType: 'delete'
				});
				gatedConfig = decision.approvalConfig ?? null;
			}

			if (beforeHook) await beforeHook({ existing: originalRecord, api });
			prepared.push({
				recordId,
				originalRecord,
				mutationContext,
				gatedConfig,
				...(gatedConfig ? { approvalRequestId: v7() } : {})
			});
		}

		// Phase 2: remove the rows. A gated delete stamps its approval id on the row first so the
		// archived history version carries it (that stamp is what approval rollback re-inserts
		// from), which is per-record work; an ungated batch is one DELETE per chunk.
		const gated = prepared.filter((item) => item.approvalRequestId != null);
		await withMutationDb(ctx, async (mutationDb) => {
			// stupidity:allow A6 -- each gated row needs its own approval stamp before it is removed.
			for (const item of gated) {
				await mutationDb
					.update(table)
					.set({ [SYSTEM_COLUMN_NAMES.APPROVAL_ID]: item.approvalRequestId })
					.where(eq(cols[SYSTEM_COLUMN_NAMES.PKEY], item.recordId));
			}
			// The _norbital_versioning trigger archives every deleted row's final state to history
			// (period closed at now) so findHistory shows the deletion and approval rollback can
			// re-insert it.
			for (let from = 0; from < prepared.length; from += DELETE_CHUNK) {
				const chunk = prepared.slice(from, from + DELETE_CHUNK);
				await mutationDb.delete(table).where(
					inArray(
						cols[SYSTEM_COLUMN_NAMES.PKEY],
						chunk.map((item) => item.recordId)
					)
				);
			}
			await emitOutboundRowsMany(
				mutationDb,
				ctx,
				collection,
				'delete',
				prepared.map((item) => ({ record: item.originalRecord }))
			);
			// `seq` is assigned in the order given, so the sync tailer sees exactly what a
			// record-at-a-time loop produced.
			await emitSyncOutboxMany(
				mutationDb,
				collection,
				'delete',
				prepared.map((item) => item.originalRecord)
			);
		});

		// Phase 3: approval requests and after hooks, in caller order, once every row is gone.
		const afterApi = deleteAfterHook ? await getElevatedAfterHookApi() : undefined;
		// stupidity:allow A6 -- approval requests and after hooks must observe caller order.
		for (const item of prepared) {
			if (item.gatedConfig && item.approvalRequestId) {
				await createApprovalRequestForGatedWrite({
					approvalConfig: item.gatedConfig,
					collectionName: collection,
					context: item.mutationContext,
					rootRecord: item.originalRecord,
					lockType: 'record_delete',
					requestId: item.approvalRequestId
				});
			}
			if (deleteAfterHook && afterApi) {
				await deleteAfterHook({ record: item.originalRecord, api: afterApi });
			}
		}

		const audits = prepared.map((item) => ({
			collectionName: collection,
			params: {
				action: 'record.delete' as const,
				entityType: collection,
				entityId: item.recordId,
				changesBefore: item.originalRecord
			},
			eventLabel: 'delete'
		}));
		await sendAuditEvents(audits);
	});
}
