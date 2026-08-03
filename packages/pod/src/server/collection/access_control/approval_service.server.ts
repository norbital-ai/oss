import type { TCollectionActionContext, TResolvedApprovalConfig } from './approval_scope_types.js';
import { collectLockedRecordRefs } from './approval_lock.server.js';
import { mutationConditionsApply } from './approval_step_conditions.server.js';
import { loadAllPolicies, loadUserById } from './policy_grant_loader.server.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import type { TScopeRequestor } from '$lib/shared/scope.js';
import { isWorkspaceCollectionName } from '$lib/shared/collection-names.js';
import {
	resolveRecordDisplayLabel,
	type ManifestContext
} from '@norbital-ai/platform-utils/manifest/context';
import { qualifiedRelationshipTable } from '@norbital-ai/platform-utils/tenant_db/schema';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import {
	type TApprovalConfig,
	type TApprovalConfigStepNode,
	type TApprovalRequest,
	type TApprovalRequestStatus,
	type TApprovalRequestStepNode,
	type TMutationActionKey
} from '@norbital-ai/platform-utils/system/types';
import { v7 } from 'uuid';
import { z } from 'zod';
import { error } from '../http_error.js';
import { approvalRequestFromRow, parseApprovalStepStacks } from '$lib/shared/approval.js';
import { withCollectionTransaction } from '../collection_transaction.server.js';
import { emitSyncOutboxRow, type SyncOutboxAction } from '../sync/sync-outbox.server.js';
import { announceVisibilityChange } from '../sync/visibility-deltas.server.js';
import { quoteSqlIdentifier } from '../sql-identifier.server.js';

const requestorMutationRefSchema = z.tuple([z.object({ record_id: z.string() }).strict()]);

type TMutationActionContext = Extract<
	TCollectionActionContext,
	{ type: 'create' | 'update' | 'delete' }
>;

type TLockType = TApprovalRequest['locked_record_refs'][number]['lock_type'];
type ApprovalLockedRecordRef = TApprovalRequest['locked_record_refs'][number];

/** Terminal states - no further actions allowed. (Withdraw is a requestor-initiated REJECTED.) */
const TERMINAL_STATES: readonly TApprovalRequestStatus[] = ['APPROVED', 'REJECTED'];

function toStepStacks(ar: { approval_step_nodes: unknown }): TApprovalRequestStepNode[][] {
	return parseApprovalStepStacks(ar.approval_step_nodes);
}

function requestorMutationRef(requestor: unknown): [{ record_id: string }] {
	return requestorMutationRefSchema.parse(requestor);
}

function isUserInGroup(group: string): boolean {
	return getWorkspace({ provision: true }).baseScope.requestor.team_members.some(
		(t) => t.norbital_id === group
	);
}

function canUserApprove(step: TApprovalRequestStepNode): boolean {
	return step.teams_that_can_approve.some((group) => isUserInGroup(group));
}

function getCurrentFlow(approvalRequest: TApprovalRequest): TApprovalRequestStepNode[] {
	return toStepStacks(approvalRequest).at(-1) ?? [];
}

function getCurrentPendingStep(approvalRequest: TApprovalRequest): TApprovalRequestStepNode | null {
	const currentFlow = getCurrentFlow(approvalRequest);
	return currentFlow.find((step) => step.status === 'PENDING') || null;
}

function deriveRequestStatus(
	stepStacks: readonly TApprovalRequestStepNode[][]
): TApprovalRequestStatus {
	const currentFlow = stepStacks.at(-1) ?? [];
	if (currentFlow.length === 0) return 'APPROVED';
	if (currentFlow.some((step) => step.status === 'REJECTED')) return 'REJECTED';
	if (currentFlow.some((step) => step.status === 'REQUEST_FOR_CHANGE')) return 'REQUEST_FOR_CHANGE';
	if (currentFlow.some((step) => step.status === 'PENDING')) return 'ONGOING';
	return 'APPROVED';
}

function updateStepWithAction(
	step: TApprovalRequestStepNode,
	action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE',
	userId: string,
	comments?: string
): TApprovalRequestStepNode {
	return {
		...step,
		status: action,
		history: [
			...step.history,
			{
				action,
				comments: comments ?? null,
				actionBy: userId,
				actionOn: new Date().toISOString()
			}
		]
	};
}

function collectionTableName(collectionName: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(collectionName)) {
		throw new Error(`Unsafe collection name: ${collectionName}`);
	}
	return collectionName;
}

/**
 * Lock the request, then read it — in that order, and inside the writing transaction.
 *
 * Locking is not enough on its own. A caller that decides from a row it read *before* the lock is
 * deciding from a snapshot: two people pressing Approve at the same moment both saw the same
 * pending step, both computed a flow that stamps it, and the second write silently replaced the
 * first. The status guard alone does not catch that, because on any multi-step flow neither
 * decision is terminal. Nor does it catch the worse one — a requestor revising the record restarts
 * the request with a new flow and a recomputed lock set, and an approver holding the pre-revision
 * snapshot overwrites both, approving content nobody reviewed and releasing the wrong records.
 *
 * So the locked row is what the decision is built from. `FOR UPDATE` serializes the callers; the
 * re-read after it means the second caller sees exactly what the first committed and either
 * refuses (terminal) or decides against the real current flow.
 */
async function lockApprovalRequest(
	tenantDb: ReturnType<typeof getWorkspace>['tenantDb'],
	approvalRequestId: string
): Promise<TApprovalRequest> {
	const locked = await tenantDb.query<{ status: TApprovalRequestStatus }>(
		`SELECT status FROM approval_request WHERE norbital_id = $1::uuid FOR UPDATE`,
		[approvalRequestId]
	);
	const status = locked.rows[0]?.status;
	if (!status) throw error(404, 'Approval request not found');
	if (TERMINAL_STATES.includes(status)) {
		throw error(
			409,
			'Cannot modify approval request: it has already reached a terminal state. ' +
				'Once approved or rejected, the decision is final.'
		);
	}
	return loadApprovalRequest(approvalRequestId);
}

/**
 * Run one approval transition: lock the request, build the new state from the locked row, write it,
 * and — on a terminal status — release the records in the same transaction.
 *
 * `buildTransition` receives the locked row and must derive everything it writes from it. Nothing
 * read before this call may reach the record it returns; that is the whole point of the lock.
 */
async function persistApprovalTransition(
	approvalRequestId: string,
	buildTransition: (
		locked: TApprovalRequest
	) => Record<string, unknown> | Promise<Record<string, unknown>>
): Promise<TApprovalRequest> {
	const workspace = getWorkspace({ provision: true });
	const tenantDb = workspace.tenantDb;
	return withCollectionTransaction(workspace, async () => {
		const locked = await lockApprovalRequest(tenantDb, approvalRequestId);
		const approvalRequest = await persistApprovalRequest(await buildTransition(locked));
		if (approvalRequest.status !== 'APPROVED' && approvalRequest.status !== 'REJECTED') {
			return approvalRequest;
		}

		await tenantDb.query(`SELECT set_config('norbital.approval_terminal_transition', 'on', true)`);
		// stupidity:allow A6 -- terminal record changes must finish before their locks are released.
		for (const ref of approvalRequest.locked_record_refs ?? []) {
			const before = await readRecordFeedState(ref.collection_name, ref.record_id);
			if (approvalRequest.status === 'APPROVED') {
				await clearApprovalStamp(ref);
			} else {
				await restoreRecordBeforeApproval(ref, approvalRequestId);
			}
			await announceRecordChange(
				ref.collection_name,
				ref.record_id,
				before,
				await readRecordFeedState(ref.collection_name, ref.record_id)
			);
			// The released record's own change is on the feed now. What is not is every record whose
			// *visibility* moved because of it — a run's payslips become readable when the run is
			// approved without a single payslip row being written. Announcing them here keeps that a
			// delta instead of something each client has to go looking for.
			await announceVisibilityChange(workspace, ref.collection_name, ref.record_id).catch(
				(cause: unknown) => {
					// Never fail the approval over an announcement. A missed announcement costs a stale
					// client until its next catch-up; a failed approval costs the decision itself.
					console.error('[sync] visibility announcement failed', cause);
				}
			);
		}
		await releaseApprovalLocks(approvalRequestId);
		return loadApprovalRequest(approvalRequestId);
	});
}

/** Whether a locked record exists, and at which version — the two facts the change feed needs. */
type TRecordFeedState = { readonly present: boolean; readonly rowVersion: number | null };

async function readRecordFeedState(
	collectionName: string,
	recordId: string
): Promise<TRecordFeedState> {
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	const result = await tenantDb.query<{ row_version: number | null }>(
		`SELECT norbital_row_version AS row_version
		   FROM ${quoteSqlIdentifier(collectionTableName(collectionName))}
		  WHERE norbital_id = $1::uuid`,
		[recordId]
	);
	const row = result.rows[0];
	return { present: row != null, rowVersion: row?.row_version ?? null };
}

function feedAction(before: TRecordFeedState, after: TRecordFeedState): SyncOutboxAction | null {
	if (after.present) return before.present ? 'update' : 'create';
	return before.present ? 'delete' : null;
}

/**
 * Publish what a privileged approval write did to one record.
 *
 * The action is read off the record itself — present before and after is an update, gone is a
 * delete, back again is a create — rather than off the branch that ran. That is deliberate: which
 * branch runs depends on the lock type, on whether a pre-approval version exists, and on how much
 * post-write activity a collection's hooks happened to generate. What a synced client needs to
 * know is only whether the row still exists and at which version, so that is what is asked. A new
 * restore strategy is announced correctly without anyone remembering to announce it.
 */
async function announceRecordChange(
	collectionName: string,
	recordId: string,
	before: TRecordFeedState,
	after: TRecordFeedState
): Promise<void> {
	const action = feedAction(before, after);
	if (!action) return;
	await emitSyncOutboxRow(
		getWorkspace({ provision: true }).tenantDb,
		collectionName,
		action,
		recordId,
		after.rowVersion ?? before.rowVersion
	);
}

async function getMutableTableColumns(tableName: string): Promise<string[]> {
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	const result = await tenantDb.query<{ column_name: string }>(
		`SELECT column_name
		   FROM information_schema.columns
		  WHERE table_schema = 'public'
		    AND table_name = $1
		    AND column_name <> 'norbital_sys_period'
		  ORDER BY ordinal_position`,
		[tableName]
	);
	return result.rows.map((row) => row.column_name);
}

async function clearApprovalStamp(ref: ApprovalLockedRecordRef): Promise<void> {
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	const tableName = collectionTableName(ref.collection_name);
	await tenantDb.query(
		`UPDATE ${quoteSqlIdentifier(tableName)}
		    SET norbital_approval_id = NULL,
		        norbital_updated_at = CURRENT_TIMESTAMP
		  WHERE norbital_id = $1::uuid`,
		[ref.record_id]
	);
}

async function tableExists(tableName: string): Promise<boolean> {
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	const result = await tenantDb.query<{ exists: boolean }>(
		`SELECT to_regclass($1) IS NOT NULL AS exists`,
		[`public.${tableName}`]
	);
	return result.rows[0]?.exists ?? false;
}

async function restoreRecordBeforeApproval(
	ref: ApprovalLockedRecordRef,
	approvalRequestId: string
): Promise<void> {
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	const tableName = collectionTableName(ref.collection_name);
	const historyTableName = `${tableName}_history`;

	// Without a temporal history table there is no prior version to roll back to: drop the row
	// (a rejected create/update leaves nothing; a rejected delete cannot be resurrected).
	if (!(await tableExists(historyTableName))) {
		await tenantDb.query(
			`DELETE FROM ${quoteSqlIdentifier(tableName)} WHERE norbital_id = $1::uuid`,
			[ref.record_id]
		);
		return;
	}

	const columns = await getMutableTableColumns(tableName); // excludes norbital_sys_period
	const quotedColumns = columns.map(quoteSqlIdentifier);

	// A rejected DELETE must bring the row back. Re-insert its final pre-delete state from history,
	// opening a fresh live period and clearing the (now-resolved) approval stamp so it is current
	// again. Runs inside the terminal transition, so _ops_guard and _approval_lock_gate both allow it.
	if (ref.lock_type === 'record_delete') {
		const reinserted = await tenantDb.query(
			`INSERT INTO ${quoteSqlIdentifier(tableName)} (${quotedColumns.join(', ')}, norbital_sys_period)
			 SELECT ${quotedColumns.join(', ')}, tstzrange(now(), NULL, '[)')
			   FROM ${quoteSqlIdentifier(historyTableName)}
			  WHERE norbital_id = $1::uuid
			  ORDER BY upper(norbital_sys_period) DESC NULLS LAST, norbital_row_version DESC
			  LIMIT 1
			 ON CONFLICT (norbital_id) DO NOTHING`,
			[ref.record_id]
		);
		if ((reinserted.rowCount ?? 0) > 0) {
			await tenantDb.query(
				`UPDATE ${quoteSqlIdentifier(tableName)} SET norbital_approval_id = NULL WHERE norbital_id = $1::uuid`,
				[ref.record_id]
			);
			return;
		}
		// No history row to resurrect from: the delete simply stands.
		await tenantDb.query(
			`DELETE FROM ${quoteSqlIdentifier(tableName)} WHERE norbital_id = $1::uuid`,
			[ref.record_id]
		);
		return;
	}

	const restoreColumns = columns.filter(
		(column) =>
			column !== 'norbital_id' &&
			column !== 'norbital_created_at' &&
			column !== 'norbital_updated_at' &&
			column !== 'norbital_row_version'
	);
	const updateAssignments = restoreColumns.map(
		(column) => `${quoteSqlIdentifier(column)} = baseline.${quoteSqlIdentifier(column)}`
	);
	const restored = await tenantDb.query(
		`UPDATE ${quoteSqlIdentifier(tableName)} AS live
		    SET ${updateAssignments.join(', ')}
		   FROM (
		          SELECT ${quotedColumns.join(', ')}
		            FROM ${quoteSqlIdentifier(historyTableName)}
		           WHERE norbital_id = $1::uuid
		             AND norbital_approval_id IS DISTINCT FROM $2::uuid
		           ORDER BY upper(norbital_sys_period) DESC NULLS LAST, norbital_row_version DESC
		           LIMIT 1
		        ) AS baseline
		  WHERE live.norbital_id = $1::uuid`,
		[ref.record_id, approvalRequestId]
	);
	if ((restored.rowCount ?? 0) > 0) return;
	await tenantDb.query(
		`DELETE FROM ${quoteSqlIdentifier(tableName)} WHERE norbital_id = $1::uuid`,
		[ref.record_id]
	);
}

async function releaseApprovalLocks(approvalRequestId: string): Promise<void> {
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	await tenantDb.query(`DELETE FROM _approval_lock WHERE approval_request_id = $1::uuid`, [
		approvalRequestId
	]);
}

// ── Approval-flow generation (resolve the concrete step nodes for a gated write) ──────────

async function evaluateApprovalStepNode(
	step_node: TApprovalConfigStepNode,
	context: TMutationActionContext,
	collectionName: string
): Promise<TApprovalRequestStepNode[]> {
	if (!(await mutationConditionsApply(step_node.conditions ?? {}, context, collectionName)))
		return [];

	const currentNode: TApprovalRequestStepNode = {
		id: step_node.id,
		name: step_node.name,
		description: step_node.description,
		teams_that_can_approve: step_node.teams_that_can_approve,
		status: 'PENDING',
		history: []
	};
	if (step_node.nextSteps.length === 0) return [currentNode];

	const nextStepsNodes = (
		await Promise.all(
			step_node.nextSteps.map((nextStep) =>
				evaluateApprovalStepNode(nextStep, context, collectionName)
			)
		)
	).flat();
	return nextStepsNodes.length === 0 ? [] : [currentNode, ...nextStepsNodes];
}

async function resolveApprovalFlow(
	approvalConfig: TApprovalConfig,
	context: TMutationActionContext,
	collectionName: string
): Promise<TApprovalRequestStepNode[] | null> {
	const flow = (
		await Promise.all(
			approvalConfig.approval_step_nodes.map((node) =>
				evaluateApprovalStepNode(node, context, collectionName)
			)
		)
	)
		.filter((steps) => steps.length > 0)
		.at(0);
	return flow ?? null;
}

/**
 * Builds the approval-request row for a **write-then-lock** gated write. The record described
 * by `rootRecord` has already been written to the tenant DB and stamped with `requestId`; this
 * draft records the workflow state and the lock set (`locked_record_refs`). There is no signing,
 * no `request_content` payload store, and no `snapshot_version` — the live record and its version
 * history are the source of truth.
 */
async function buildApprovalRequestDraft(params: {
	approvalConfig: TApprovalConfig;
	collectionName: string;
	context: TMutationActionContext;
	rootRecord: Record<string, unknown>;
	lockType: TLockType;
	requestId?: string;
}): Promise<Record<string, unknown>> {
	const { approvalConfig, collectionName, context, rootRecord, lockType, requestId } = params;
	const ws = getWorkspace({ provision: true });
	const manifestCtx = ws.manifestCtx;

	const flow = await resolveApprovalFlow(approvalConfig, context, collectionName);
	if (!flow) {
		throw error(400, 'No valid approval steps found. Contact your system administrator.');
	}

	const collectionMetadata = {
		...manifestCtx.getCollection(collectionName),
		collection_name: collectionName
	};
	const label = resolveRecordDisplayLabel(collectionMetadata, rootRecord).text;
	const requestor = await loadUserById(context.scope.requestor.norbital_id);
	const requestorUserId = requestor?.[SYSTEM_COLUMN_NAMES.PKEY];
	if (typeof requestorUserId !== 'string') {
		throw error(401, 'Requestor user not found.');
	}

	const now = new Date().toISOString();
	return {
		norbital_id: requestId ?? v7(),
		organization_id: ws.organization.norbital_id,
		label,
		approval_config_id: approvalConfig.norbital_id,
		collection_name: collectionName,
		requestor: [{ record_id: requestorUserId }],
		status: deriveRequestStatus([flow]),
		approval_step_nodes: [flow],
		locked_record_refs: collectLockedRecordRefs(
			collectionMetadata,
			rootRecord,
			manifestCtx,
			lockType
		),
		norbital_created_at: now,
		norbital_updated_at: now
	};
}

export async function findApprovalConfigInWorkspace(
	manifestCtx: ManifestContext,
	approvalConfigId: string
): Promise<{
	approvalConfigPermission: TResolvedApprovalConfig;
	actionType: TMutationActionKey;
} | null> {
	const policies = await loadAllPolicies();
	for (const policy of policies) {
		if (!policy.is_active) continue;
		const grants = Array.isArray(policy.grants) ? policy.grants : [];
		for (const grant of grants) {
			const cfg =
				typeof grant === 'object' && grant !== null && 'approval_config' in grant
					? (grant.approval_config as TApprovalConfig | null | undefined)
					: null;
			if (!cfg) continue;

			const action = grant.action;
			if (action !== 'create' && action !== 'update' && action !== 'delete') continue;

			if (cfg.norbital_id !== approvalConfigId) {
				continue;
			}

			const collectionName = String(grant.collection_name);
			isWorkspaceCollectionName(manifestCtx, collectionName, { throw: true });
			return {
				approvalConfigPermission: {
					...cfg,
					collection_name: collectionName
				},
				actionType: action
			};
		}
	}

	return null;
}

// ── Persistence helpers ──────────────────────────────────────────

/**
 * Writable `c_approval_request` columns and how each binds to SQL. `requestor` is written to its
 * junction table separately. `jsonb[]` columns bind an array of JSON strings (node-pg formats the
 * array literal; `::jsonb[]` casts it).
 */
const APPROVAL_REQUEST_COLUMNS: Record<string, { cast: string; toParam: (v: unknown) => unknown }> =
	{
		organization_id: { cast: '', toParam: (v) => v },
		label: { cast: '', toParam: (v) => v },
		approval_config_id: { cast: '', toParam: (v) => v },
		collection_name: { cast: '', toParam: (v) => v },
		status: { cast: '', toParam: (v) => v },
		approval_step_nodes: {
			cast: '::jsonb',
			toParam: (v) => JSON.stringify(v ?? [])
		},
		locked_record_refs: {
			cast: '::jsonb',
			toParam: (v) => JSON.stringify(v ?? [])
		},
		closed_at: { cast: '::timestamptz', toParam: (v) => v ?? null },
		norbital_updated_at: { cast: '::timestamptz', toParam: (v) => v ?? null }
	};

/**
 * System writer for `approval_request`. The generic mutation compiler is forbidden from touching
 * this collection; this is the single privileged write path. It UPSERTs
 * the row directly (only the columns present in `record`) and links the `requestor` junction.
 */
const APPROVAL_REQUEST_COLLECTION = 'approval_request';

const APPROVAL_REQUEST_REQUESTOR_TABLE = qualifiedRelationshipTable(
	'requestor',
	'approval_request',
	'user'
);

async function persistApprovalRequest(record: Record<string, unknown>): Promise<TApprovalRequest> {
	const { requestor, norbital_id: norbitalId, ...rest } = record;
	if (typeof norbitalId !== 'string') {
		throw new Error('Approval request persistence requires a norbital_id.');
	}

	const cols = ['norbital_id'];
	const placeholders = ['$1::uuid'];
	const values: unknown[] = [norbitalId];
	const setClauses: string[] = [];
	for (const [col, spec] of Object.entries(APPROVAL_REQUEST_COLUMNS)) {
		if (!(col in rest)) continue;
		values.push(spec.toParam(rest[col]));
		cols.push(col);
		placeholders.push(`$${values.length}${spec.cast}`);
		setClauses.push(`${col} = EXCLUDED.${col}`);
	}

	const conflict = setClauses.length > 0 ? `DO UPDATE SET ${setClauses.join(', ')}` : 'DO NOTHING';
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	// An approval request is a record a synced client reads — the Approval tab of a record detail
	// renders its `status`. So every write here is announced on the same probe the terminal
	// transition uses: nothing else on the client will ask for this row again, and a status the
	// feed never carried is a status no client ever sees. That covers the transitions no approval
	// endpoint drives — above all the restart a *revision* performs, which moves the request back
	// to ONGOING from inside an ordinary record update.
	const before = await readRecordFeedState(APPROVAL_REQUEST_COLLECTION, norbitalId);
	await tenantDb.query(
		`INSERT INTO approval_request (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (norbital_id) ${conflict}`,
		values
	);

	const requestorRef = requestorMutationRef(requestor);
	const requestorId = requestorRef[0].record_id;
	await tenantDb.query(
		`INSERT INTO ${APPROVAL_REQUEST_REQUESTOR_TABLE} (approval_request_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
		[norbitalId, requestorId]
	);
	const verify = await tenantDb.query<{ user_id: string }>(
		`SELECT user_id
			   FROM ${APPROVAL_REQUEST_REQUESTOR_TABLE}
			  WHERE approval_request_id = $1::uuid
			  LIMIT 1`,
		[norbitalId]
	);
	if (!verify.rows[0]?.user_id) {
		throw error(
			500,
			`Failed to link approval request requestor (approval_request_id=${norbitalId}, user_id=${requestorId}).`
		);
	}
	await announceRecordChange(
		APPROVAL_REQUEST_COLLECTION,
		norbitalId,
		before,
		await readRecordFeedState(APPROVAL_REQUEST_COLLECTION, norbitalId)
	);

	return loadApprovalRequest(norbitalId);
}

/** Privileged single-row read of an approval request (with requestor joined via `with`). */
export async function loadApprovalRequestRow(
	approvalRequestId: string
): Promise<TApprovalRequest | null> {
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	const result = await tenantDb.query<{
		norbital_id: string;
		organization_id: string;
		label: string;
		approval_config_id: string;
		collection_name: string;
		status: TApprovalRequestStatus;
		approval_step_nodes: unknown;
		locked_record_refs: unknown;
		closed_at: string | null;
		norbital_created_at: string;
		norbital_updated_at: string;
		norbital_sys_period: string;
		norbital_row_version: number;
		norbital_approval_id: string | null;
	}>(
		`SELECT norbital_id,
		        organization_id,
		        label,
		        approval_config_id,
		        collection_name,
		        status,
		        approval_step_nodes,
		        locked_record_refs,
		        closed_at,
		        norbital_created_at,
		        norbital_updated_at,
		        norbital_sys_period,
		        norbital_row_version,
		        norbital_approval_id
		   FROM approval_request
		  WHERE norbital_id = $1::uuid
		  LIMIT 1`,
		[approvalRequestId]
	);
	const row = result.rows[0];
	if (!row) return null;

	const requestorResult = await tenantDb.query<{ user_id: string }>(
		`SELECT user_id
		   FROM ${APPROVAL_REQUEST_REQUESTOR_TABLE}
		  WHERE approval_request_id = $1::uuid
		  LIMIT 1`,
		[approvalRequestId]
	);
	const requestorUserId = requestorResult.rows[0]?.user_id;
	if (!requestorUserId) {
		throw error(500, `Approval request ${approvalRequestId} has no requestor relationship.`);
	}

	return approvalRequestFromRow({
		norbital_id: row.norbital_id,
		organization_id: row.organization_id,
		label: row.label,
		approval_config_id: row.approval_config_id,
		collection_name: row.collection_name,
		status: row.status,
		approval_step_nodes: row.approval_step_nodes,
		locked_record_refs: row.locked_record_refs,
		closed_at: row.closed_at,
		norbital_created_at: row.norbital_created_at,
		norbital_updated_at: row.norbital_updated_at,
		norbital_sys_period: row.norbital_sys_period,
		norbital_row_version: row.norbital_row_version,
		norbital_approval_id: row.norbital_approval_id,
		requestor: [{ record_id: requestorUserId }]
	});
}

async function loadApprovalRequest(approvalRequestId: string): Promise<TApprovalRequest> {
	const existing = await loadApprovalRequestRow(approvalRequestId);
	if (!existing) throw error(404, 'Approval request not found');
	return existing;
}

// ── Write-then-lock lifecycle ────────────────────────────────────

/**
 * Creates the approval request for a brand-new GATED write. The record has already been written
 * to the tenant DB (stamped with `requestId`); this records the workflow + lock set. Inserting the
 * row triggers `_approval_lock_sync`, which materializes the locks from `locked_record_refs`.
 */
export async function createApprovalRequestForGatedWrite(params: {
	approvalConfig: TApprovalConfig;
	collectionName: string;
	context: TMutationActionContext;
	rootRecord: Record<string, unknown>;
	lockType: TLockType;
	requestId: string;
}): Promise<TApprovalRequest> {
	const draft = await buildApprovalRequestDraft(params);
	return persistApprovalRequest(draft);
}

/**
 * Opens the one permitted write channel for an approval-stamped record. The approval row is
 * locked until the surrounding collection transaction commits, so authorization, the revision,
 * and the restarted or auto-resolved flow are one atomic lifecycle.
 */
export async function authorizeApprovalRequestRevision(params: {
	approvalRequestId: string;
	collectionName: string;
	recordId: string;
	requestorId: string;
}): Promise<void> {
	const { approvalRequestId, collectionName, recordId, requestorId } = params;
	const tenantDb = getWorkspace({ provision: true }).tenantDb;
	const result = await tenantDb.query<{
		status: TApprovalRequestStatus;
		collection_name: string;
		requestor_id: string | null;
		has_lock: boolean;
	}>(
		`SELECT ar.status,
		        ar.collection_name,
		        requestor.user_id AS requestor_id,
		        EXISTS (
		          SELECT 1
		            FROM _approval_lock approval_lock
		           WHERE approval_lock.approval_request_id = ar.norbital_id
		             AND approval_lock.collection_name = $2
		             AND approval_lock.record_id = $3::uuid
		             AND approval_lock.lock_type = 'record_mutation'
		        ) AS has_lock
		   FROM approval_request ar
		   LEFT JOIN ${APPROVAL_REQUEST_REQUESTOR_TABLE} requestor
		     ON requestor.approval_request_id = ar.norbital_id
		  WHERE ar.norbital_id = $1::uuid
		  LIMIT 1
		  FOR UPDATE OF ar`,
		[approvalRequestId, collectionName, recordId]
	);
	const approvalRequest = result.rows[0];
	if (
		!approvalRequest ||
		approvalRequest.collection_name !== collectionName ||
		!approvalRequest.has_lock
	) {
		throw error(409, 'Cannot revise record: its approval request is not active for this record.');
	}
	if (approvalRequest.requestor_id !== requestorId) {
		throw error(403, 'Only the original requestor can revise this approval request.');
	}
	if (approvalRequest.status !== 'REQUEST_FOR_CHANGE') {
		throw error(409, 'Cannot revise record until an approver requests changes.');
	}

	await tenantDb.query(`SELECT set_config('norbital.approval_revision_request_id', $1, true)`, [
		approvalRequestId
	]);
}

/**
 * Restarts an open request after the requestor revised the locked record. The revised data was
 * re-evaluated and still requires approval (possibly under a *different* config). A fresh flow is
 * appended (all steps PENDING), `approval_config_id` is updated, and `locked_record_refs` are
 * recomputed from the new payload. Prior flows are archived; the last (new) flow is active.
 */
export async function restartApprovalRequestForRevision(params: {
	approvalRequestId: string;
	approvalConfig: TResolvedApprovalConfig;
	context: TMutationActionContext;
	rootRecord: Record<string, unknown>;
	lockType: TLockType;
}): Promise<TApprovalRequest> {
	const { approvalRequestId, approvalConfig, context, rootRecord, lockType } = params;
	const existing = await loadApprovalRequest(approvalRequestId);
	const manifestCtx = getWorkspace({ provision: true }).manifestCtx;
	const collectionMetadata = {
		...manifestCtx.getCollection(approvalConfig.collection_name),
		collection_name: approvalConfig.collection_name
	};

	const newFlow = await resolveApprovalFlow(
		approvalConfig,
		context,
		approvalConfig.collection_name
	);
	if (!newFlow) {
		throw error(400, 'No valid approval steps found for the revised record.');
	}
	const approvalStepNodes = [...toStepStacks(existing), newFlow];

	return persistApprovalRequest({
		norbital_id: existing.norbital_id,
		requestor: Reflect.get(existing, 'requestor'),
		label: resolveRecordDisplayLabel(collectionMetadata, rootRecord).text,
		approval_config_id: approvalConfig.norbital_id,
		collection_name: approvalConfig.collection_name,
		organization_id: existing.organization_id,
		status: deriveRequestStatus(approvalStepNodes),
		approval_step_nodes: approvalStepNodes,
		locked_record_refs: collectLockedRecordRefs(
			collectionMetadata,
			rootRecord,
			manifestCtx,
			lockType
		),
		norbital_updated_at: new Date().toISOString()
	});
}

/**
 * Resolves an open request as APPROVED without further review. Used when a revision makes the
 * record directly/conditionally accessible (no approval needed): appending an empty flow derives
 * `APPROVED`, then the same transaction releases locks and clears the record stamp. The change stands.
 */
export async function autoResolveApprovalRequest(
	approvalRequestId: string
): Promise<TApprovalRequest> {
	return persistApprovalTransition(approvalRequestId, (existing) => {
		const approvalStepNodes = [...toStepStacks(existing), []];
		// The identity columns are carried through from the locked row, not omitted as "unchanged".
		// The write is an UPSERT, and Postgres enforces NOT NULL on the proposed tuple *before* it
		// looks for the conflict — so a partial column list makes the statement fail on
		// `organization_id` even though the row it would have updated already has one.
		return {
			norbital_id: existing.norbital_id,
			requestor: Reflect.get(existing, 'requestor'),
			label: existing.label,
			approval_config_id: existing.approval_config_id,
			collection_name: existing.collection_name,
			organization_id: existing.organization_id,
			status: deriveRequestStatus(approvalStepNodes),
			approval_step_nodes: approvalStepNodes,
			locked_record_refs: existing.locked_record_refs ?? [],
			norbital_updated_at: new Date().toISOString()
		};
	});
}

/**
 * Requestor-initiated cancellation. Modeled as a `REJECTED` (there is no separate WITHDRAWN
 * status): the current pending step is marked REJECTED on the requestor's behalf, which derives
 * `REJECTED`, rolls records back, releases locks, and stamps `closed_at` in one transaction.
 */
export async function withdrawApprovalRequest(
	approvalRequestId: string,
	user: TScopeRequestor
): Promise<TApprovalRequest> {
	return persistApprovalTransition(approvalRequestId, (existing) => {
		// Authorization is decided from the locked row too. The requestor of record can be rewritten
		// by a revision restart, so a check taken before the lock could admit someone who is no
		// longer the requestor — or refuse someone who now is.
		const requestorRef = requestorMutationRef(Reflect.get(existing, 'requestor'));
		const requestorId = requestorRef[0].record_id;
		if (requestorId !== user.norbital_id) {
			throw error(403, 'Only the requestor can withdraw their own approval request.');
		}

		const currentFlow = getCurrentFlow(existing);
		const flowHistory = toStepStacks(existing).slice(0, -1);
		const pendingStep = getCurrentPendingStep(existing);
		const rejectedFlow = currentFlow.map((step) =>
			!pendingStep || step.id === pendingStep.id
				? updateStepWithAction(step, 'REJECTED', user.norbital_id, 'Withdrawn by requestor')
				: step
		);
		const approvalStepNodes = [...flowHistory, rejectedFlow];

		return {
			norbital_id: existing.norbital_id,
			requestor: Reflect.get(existing, 'requestor'),
			label: existing.label,
			approval_config_id: existing.approval_config_id,
			collection_name: existing.collection_name,
			organization_id: existing.organization_id,
			status: deriveRequestStatus(approvalStepNodes),
			approval_step_nodes: approvalStepNodes,
			locked_record_refs: existing.locked_record_refs ?? [],
			closed_at: new Date().toISOString(),
			norbital_updated_at: new Date().toISOString()
		};
	});
}

/**
 * Records an approver action (approve / reject / request-for-change) on the current pending step.
 * The DB derives `status` from the step nodes; terminal record restoration/finalization and lock
 * release commit atomically with that status. This never replays a stored payload.
 *
 * `approvalRequest` names which request to act on and nothing else — the flow acted upon is the one
 * read under the lock, not the one the caller was holding.
 */
export async function processAction(
	action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE',
	approvalRequest: TApprovalRequest,
	approvalConfig: TApprovalConfig,
	user: TScopeRequestor,
	isSupercede: boolean,
	comments?: string
): Promise<TApprovalRequest> {
	return persistApprovalTransition(approvalRequest.norbital_id, (existing) => {
		const currentFlow = getCurrentFlow(existing);
		const flowHistory = toStepStacks(existing).slice(0, -1);

		let updatedFlow: TApprovalRequestStepNode[];
		if (isSupercede) {
			if (!approvalConfig.supercede_teams.some((group: string) => isUserInGroup(group))) {
				throw new Error('No permissions to supercede.');
			}
			updatedFlow = currentFlow.map((step) =>
				updateStepWithAction(step, action, user.norbital_id, comments)
			);
		} else {
			// Read off the locked flow, not the one the caller was shown. Whoever committed first may
			// have advanced the request past this step — or replaced the flow outright with a revision
			// restart — and the step this decision lands on has to be the one that is pending now.
			const currentPendingStep = getCurrentPendingStep(existing);
			if (!currentPendingStep) {
				throw new Error('No pending approval steps found. The request may already be completed.');
			}
			if (!canUserApprove(currentPendingStep)) {
				throw new Error(
					`You're not authorized to approve the current pending step '${currentPendingStep.name}'. ` +
						`This step requires approval from: ${currentPendingStep.teams_that_can_approve.join(', ')}.`
				);
			}
			updatedFlow = currentFlow.map((step) =>
				step.id === currentPendingStep.id
					? updateStepWithAction(step, action, user.norbital_id, comments)
					: step
			);
		}
		const approvalStepNodes = [...flowHistory, updatedFlow];

		return {
			norbital_id: existing.norbital_id,
			requestor: Reflect.get(existing, 'requestor'),
			label: existing.label,
			approval_config_id: existing.approval_config_id,
			collection_name: existing.collection_name,
			organization_id: existing.organization_id,
			status: deriveRequestStatus(approvalStepNodes),
			approval_step_nodes: approvalStepNodes,
			locked_record_refs: existing.locked_record_refs ?? [],
			norbital_updated_at: new Date().toISOString()
		};
	});
}
