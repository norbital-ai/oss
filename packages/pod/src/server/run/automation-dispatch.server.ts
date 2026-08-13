import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { readSyncOutboxBatch, OUTBOX_CURSOR_START, type OutboxCursor } from '$lib/server/collection/sync/outbox-tailer.server.js';
import { withCollectionTransaction } from '$lib/server/collection/collection_transaction.server.js';
import type { DurableAutomationAiEffect, DurableAutomationAiOutcome } from '$lib/host/types.js';
import {
	automationReplayStorage,
	isAutomationEffectYield,
	type AutomationReplayContext,
	type DurableAutomationEffect
} from './automation-replay.server.js';
import { executeAutomationHandler } from './tenant_run.js';

/** Interactive chat jobs. `automation_run.automation_name` stays null; this is only the job key. */
export const INTERACTIVE_AGENT_AUTOMATION_NAME = 'agent:interactive';

/** Stamped by guest admit; Core's next `admit` rewrites these to the live artifact. */
export const GUEST_ADMIT_ARTIFACT_MARKER = 'guest-admit';

export function channelAgentAutomationName(channelKey: string): string {
	return `channel:${channelKey}`;
}

export function isGuestAdmittedAgentJob(automationName: string): boolean {
	return (
		automationName === INTERACTIVE_AGENT_AUTOMATION_NAME || automationName.startsWith('channel:')
	);
}

export type ChangeAction = 'create' | 'update' | 'delete';
export type AutomationEvent = 'created' | 'updated' | 'deleted';
type RegisteredAutomation = { readonly trigger?: unknown };

type AutomationReceipt = {
	readonly norbital_id: string;
	readonly automation_name: string;
	readonly artifact_id: string;
	readonly checkpoint_id: string;
	readonly tree_hash: string;
	readonly runtime_version: string;
	readonly origin_scope: Record<string, unknown> | null;
	readonly record_snapshot: Record<string, unknown> | null;
	readonly continuation: { readonly effects?: readonly DurableAutomationEffect[] } | null;
};

export type AutomationAdmission = {
	readonly epoch: string;
	readonly receipts: readonly { readonly receiptId: string; readonly artifact: AutomationArtifactBinding }[];
};

export type AutomationArtifactBinding = {
	readonly artifactId: string;
	readonly checkpointId: string;
	readonly treeHash: string;
	readonly runtimeVersion: string;
};

export type AutomationStepOutcome =
	| { readonly status: 'completed'; readonly receiptId: string }
	| { readonly status: 'failed'; readonly receiptId: string; readonly error: string }
	| ({ readonly status: 'waiting_effect'; readonly receiptId: string } & DurableAutomationAiEffect);

export function eventForAction(action: ChangeAction): AutomationEvent {
	return action === 'create' ? 'created' : action === 'update' ? 'updated' : 'deleted';
}

export function matchChangeAutomations(
	automations: Record<string, RegisteredAutomation> | undefined,
	collection: string,
	event: AutomationEvent
): string[] {
	if (!automations) return [];
	return Object.entries(automations)
		.filter(([, automation]) => {
			const outer = automation?.trigger;
			if (!outer || typeof outer !== 'object' || !('trigger' in outer)) return false;
			const trigger = (outer as { trigger: { collection?: unknown; event?: unknown } }).trigger;
			return trigger.collection === collection && trigger.event === event;
		})
		.map(([name]) => name)
		.sort();
}

export async function dispatchChangeToAutomations(
	_ctx: ProvisionedContext,
	change: { collection: string; action: ChangeAction; record: Record<string, unknown> }
): Promise<string[]> {
	return matchChangeAutomations(
		getTenantWorkspace().registered.automations as Record<string, RegisteredAutomation> | undefined,
		change.collection,
		eventForAction(change.action)
	);
}

export async function pumpAutomations(
	ctx: ProvisionedContext,
	cursor: OutboxCursor = OUTBOX_CURSOR_START,
	limit = 200,
	onAdvance?: (cursor: OutboxCursor) => Promise<void>
): Promise<OutboxCursor> {
	const batch = await readSyncOutboxBatch(ctx, cursor, limit);
	for (const row of batch.rows) await onAdvance?.({ xid: row.xid, seq: row.seq });
	return batch.cursor;
}

async function tenantEpoch(ctx: ProvisionedContext): Promise<string> {
	const result = await ctx.tenantDb.query<{ epoch: string }>(
		`SELECT epoch::text AS epoch FROM _norbital_sync_epoch WHERE singleton = TRUE`
	);
	const epoch = result.rows[0]?.epoch;
	if (!epoch) throw new Error('Tenant database epoch is missing');
	return epoch;
}

/** Atomically turn committed outbox snapshots into immutable DBOS admission receipts. */
export async function admitEventAutomations(
	ctx: ProvisionedContext,
	artifact: AutomationArtifactBinding,
	limit = 200
): Promise<AutomationAdmission> {
	return withCollectionTransaction(ctx, async () => {
		const stored = await ctx.tenantDb.query<{ xid: string; seq: string }>(
			`SELECT xid::text AS xid, seq::text AS seq FROM _norbital_automation_cursor
			  WHERE singleton = TRUE FOR UPDATE`
		);
		const cursor = stored.rows[0] ?? OUTBOX_CURSOR_START;
		const batch = await readSyncOutboxBatch(ctx, cursor, limit);
		const registered = getTenantWorkspace().registered.automations as
			| Record<string, RegisteredAutomation>
			| undefined;
		const jobs = batch.rows.flatMap((row) =>
			matchChangeAutomations(registered, row.collection, eventForAction(row.action)).map(
				(automationName) => ({ automationName, row })
			)
		);
		if (jobs.length > 0) {
			const params: unknown[] = [];
			const values = jobs.map(({ automationName, row }, index) => {
				const offset = index * 9;
				params.push(
					automationName,
					`event:${row.xid}:${row.seq}`,
					artifact.artifactId,
					artifact.checkpointId,
					artifact.treeHash,
					artifact.runtimeVersion,
					JSON.stringify(row.originScope),
					JSON.stringify(row.recordSnapshot),
					`${row.xid}:${row.seq}`
				);
				return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, $${offset + 8}::jsonb, $${offset + 9})`;
			});
			await ctx.tenantDb.query(
				`INSERT INTO _norbital_automation_job
				   (automation_name, trigger_key, artifact_id, checkpoint_id, tree_hash, runtime_version,
				    origin_scope, record_snapshot, source_pointer)
				 VALUES ${values.join(', ')} ON CONFLICT (automation_name, trigger_key) DO NOTHING`,
				params
			);
		}
		await ctx.tenantDb.query(
			`UPDATE _norbital_automation_job
			    SET artifact_id = $1, checkpoint_id = $2, tree_hash = $3, runtime_version = $4,
			        updated_at = CURRENT_TIMESTAMP
			  WHERE orchestration_status = 'admitted' AND artifact_id = $5`,
			[
				artifact.artifactId,
				artifact.checkpointId,
				artifact.treeHash,
				artifact.runtimeVersion,
				GUEST_ADMIT_ARTIFACT_MARKER
			]
		);
		if (batch.rows.length > 0) {
			await ctx.tenantDb.query(
				`UPDATE _norbital_automation_cursor SET xid = $1::xid8, seq = $2::bigint
				  WHERE singleton = TRUE`,
				[batch.cursor.xid, batch.cursor.seq]
			);
		}
		const receipts = await ctx.tenantDb.query<{
			norbital_id: string; artifact_id: string; checkpoint_id: string; tree_hash: string; runtime_version: string;
		}>(
			`SELECT norbital_id::text, artifact_id, checkpoint_id, tree_hash, runtime_version
			   FROM _norbital_automation_job
			  WHERE orchestration_status = 'admitted' ORDER BY created_at, norbital_id LIMIT $1`,
			[limit]
		);
		return {
			epoch: await tenantEpoch(ctx),
			receipts: receipts.rows.map((row) => ({
				receiptId: row.norbital_id,
				artifact: { artifactId: row.artifact_id, checkpointId: row.checkpoint_id,
					treeHash: row.tree_hash, runtimeVersion: row.runtime_version }
			}))
		};
	});
}

export async function admitScheduledAutomation(
	ctx: ProvisionedContext,
	input: { automationName: string; occurrenceId: string; artifact: AutomationArtifactBinding }
): Promise<AutomationAdmission> {
	await ctx.tenantDb.query(
		`INSERT INTO _norbital_automation_job
		   (automation_name, trigger_key, artifact_id, checkpoint_id, tree_hash, runtime_version,
		    origin_scope, record_snapshot, source_pointer)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '{}'::jsonb, $8)
		 ON CONFLICT (automation_name, trigger_key) DO NOTHING`,
		[
			input.automationName,
			`schedule:${input.occurrenceId}`,
			input.artifact.artifactId,
			input.artifact.checkpointId,
			input.artifact.treeHash,
			input.artifact.runtimeVersion,
			JSON.stringify(ctx.baseScope),
			input.occurrenceId
		]
	);
	const receipt = await ctx.tenantDb.query<{
		norbital_id: string; artifact_id: string; checkpoint_id: string; tree_hash: string; runtime_version: string;
	}>(
		`SELECT norbital_id::text, artifact_id, checkpoint_id, tree_hash, runtime_version
		   FROM _norbital_automation_job
		  WHERE automation_name = $1 AND trigger_key = $2`,
		[input.automationName, `schedule:${input.occurrenceId}`]
	);
	return {
		epoch: await tenantEpoch(ctx),
		receipts: receipt.rows.map((row) => ({ receiptId: row.norbital_id, artifact: {
			artifactId: row.artifact_id, checkpointId: row.checkpoint_id,
			treeHash: row.tree_hash, runtimeVersion: row.runtime_version
		} }))
	};
}

export async function admitAgentTurn(
	ctx: ProvisionedContext,
	input: {
		readonly automationName: string;
		readonly triggerKey: string;
		readonly originScope: Record<string, unknown>;
		readonly snapshot: Record<string, unknown>;
	}
): Promise<void> {
	await ctx.tenantDb.query(
		`INSERT INTO _norbital_automation_job
		   (automation_name, trigger_key, artifact_id, checkpoint_id, tree_hash, runtime_version,
		    origin_scope, record_snapshot, source_pointer)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
		 ON CONFLICT (automation_name, trigger_key) DO NOTHING`,
		[
			input.automationName,
			input.triggerKey,
			GUEST_ADMIT_ARTIFACT_MARKER,
			GUEST_ADMIT_ARTIFACT_MARKER,
			GUEST_ADMIT_ARTIFACT_MARKER,
			GUEST_ADMIT_ARTIFACT_MARKER,
			JSON.stringify(input.originScope),
			JSON.stringify(input.snapshot),
			input.triggerKey
		]
	);
}

function receiptUsesAgentReducer(receipt: AutomationReceipt): boolean {
	return isGuestAdmittedAgentJob(receipt.automation_name);
}

async function stageEffect(
	ctx: ProvisionedContext,
	receiptId: string,
	effect: DurableAutomationAiEffect
): Promise<AutomationStepOutcome> {
	await ctx.tenantDb.query(
		`UPDATE _norbital_automation_job SET orchestration_status = 'waiting_effect',
		    effect_id = $2, effect_ordinal = $3, effect_request_hash = $4,
		    effect_request = $5::jsonb, updated_at = CURRENT_TIMESTAMP
		  WHERE norbital_id = $1::uuid`,
		[receiptId, effect.effectId, effect.ordinal, effect.requestHash, JSON.stringify(effect.request)]
	);
	return { status: 'waiting_effect', receiptId, ...effect };
}

/** Execute one DBOS-selected receipt step; DBOS, not the tenant table, owns retries and leases. */
export async function runAutomationReceipt(
	ctx: ProvisionedContext,
	receiptId: string,
	expectedArtifact: AutomationArtifactBinding
): Promise<AutomationStepOutcome> {
	const selected = await ctx.tenantDb.query<AutomationReceipt>(
		`SELECT norbital_id::text, automation_name, artifact_id, checkpoint_id, tree_hash,
		        runtime_version, origin_scope, record_snapshot, continuation
		   FROM _norbital_automation_job WHERE norbital_id = $1::uuid`,
		[receiptId]
	);
	const receipt = selected.rows[0];
	if (!receipt) throw new Error(`Unknown automation receipt ${receiptId}`);
	if (receipt.artifact_id !== expectedArtifact.artifactId ||
		receipt.checkpoint_id !== expectedArtifact.checkpointId ||
		receipt.tree_hash !== expectedArtifact.treeHash ||
		receipt.runtime_version !== expectedArtifact.runtimeVersion) {
		throw new Error(`Automation receipt ${receiptId} is bound to a different runtime artifact`);
	}
	const replay: AutomationReplayContext = {
		jobId: receiptId,
		effects: receipt.continuation?.effects ?? [],
		nextOrdinal: 0
	};
	let authoredFailure: unknown;
	const runHandler = async (): Promise<void> => {
		await automationReplayStorage.run(replay, async () => {
			try {
				await executeAutomationHandler({
					automationName: receipt.automation_name,
					scope: { ...(receipt.origin_scope ?? {}), incoming_record: receipt.record_snapshot ?? {} }
				});
			} catch (cause) {
				if (replay.pending || isAutomationEffectYield(cause)) throw replay.pending ?? cause;
				authoredFailure = cause;
			}
		});
	};
	try {
		if (receiptUsesAgentReducer(receipt)) {
			await runHandler();
		} else {
			await withCollectionTransaction(ctx, async () => {
				await runHandler();
				if (authoredFailure) {
					const error =
						authoredFailure instanceof Error ? authoredFailure.message : String(authoredFailure);
					await ctx.tenantDb.query(
						`UPDATE _norbital_automation_job SET orchestration_status = 'failed', last_error = $2,
					 updated_at = CURRENT_TIMESTAMP WHERE norbital_id = $1::uuid`,
						[receiptId, error]
					);
					return;
				}
				await ctx.tenantDb.query(
					`UPDATE _norbital_automation_job SET orchestration_status = 'succeeded', last_error = NULL,
				 updated_at = CURRENT_TIMESTAMP WHERE norbital_id = $1::uuid`,
					[receiptId]
				);
			});
		}
	} catch (cause) {
		const pending = replay.pending ?? (isAutomationEffectYield(cause) ? cause : undefined);
		if (pending) {
			return stageEffect(ctx, receiptId, {
				jobId: receiptId,
				effectId: pending.effectId,
				ordinal: pending.ordinal,
				requestHash: pending.requestHash,
				request: pending.request
			});
		}
		throw cause;
	}
	if (receiptUsesAgentReducer(receipt)) {
		if (authoredFailure) {
			const error = authoredFailure instanceof Error ? authoredFailure.message : String(authoredFailure);
			await ctx.tenantDb.query(
				`UPDATE _norbital_automation_job SET orchestration_status = 'failed', last_error = $2,
				 updated_at = CURRENT_TIMESTAMP WHERE norbital_id = $1::uuid`,
				[receiptId, error]
			);
		} else {
			await ctx.tenantDb.query(
				`UPDATE _norbital_automation_job SET orchestration_status = 'succeeded', last_error = NULL,
				 updated_at = CURRENT_TIMESTAMP WHERE norbital_id = $1::uuid`,
				[receiptId]
			);
		}
	}
	if (authoredFailure) {
		return {
			status: 'failed',
			receiptId,
			error: authoredFailure instanceof Error ? authoredFailure.message : String(authoredFailure)
		};
	}
	return { status: 'completed', receiptId };
}

export async function settleAutomationEffect(
	ctx: ProvisionedContext,
	receiptId: string,
	effectId: string,
	outcome: DurableAutomationAiOutcome
): Promise<void> {
	await withCollectionTransaction(ctx, async () => {
		const selected = await ctx.tenantDb.query<{
			effect_id: string | null;
			effect_ordinal: number | null;
			effect_request_hash: string | null;
			continuation: { effects?: DurableAutomationEffect[] } | null;
		}>(
			`SELECT effect_id, effect_ordinal, effect_request_hash, continuation
			   FROM _norbital_automation_job WHERE norbital_id = $1::uuid FOR UPDATE`,
			[receiptId]
		);
		const row = selected.rows[0];
		if (!row) throw new Error(`Unknown automation receipt ${receiptId}`);
		if (row.effect_id !== effectId || row.effect_ordinal == null || !row.effect_request_hash) {
			throw new Error(`Automation effect ${effectId} does not match receipt ${receiptId}`);
		}
		const effects = [...(row.continuation?.effects ?? [])];
		if (!effects.some((entry) => entry.ordinal === row.effect_ordinal)) {
			effects.push({
				ordinal: row.effect_ordinal,
				requestHash: row.effect_request_hash,
				status: outcome.status,
				...(outcome.status === 'succeeded' ? { result: outcome.result } : { error: outcome.error })
			});
		}
		await ctx.tenantDb.query(
			`UPDATE _norbital_automation_job SET orchestration_status = 'admitted',
			 continuation = $2::jsonb, effect_id = NULL, effect_ordinal = NULL,
			 effect_request_hash = NULL, effect_request = NULL, updated_at = CURRENT_TIMESTAMP
			 WHERE norbital_id = $1::uuid`,
			[receiptId, JSON.stringify({ effects })]
		);
	});
}
