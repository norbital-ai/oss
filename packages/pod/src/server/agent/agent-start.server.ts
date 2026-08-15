/**
 * Interactive agent start: drizzle compiles the writes; one host `db.batch` commits them.
 *
 * Collection create/update used to spend the 2s isolate wall on isolate→host→Neon hops
 * before the host could enqueue anything. Pre-generated ids mean the statements do not
 * need RETURNING between them.
 */
import { v7 } from 'uuid';
import { and, eq } from 'drizzle-orm';
import {
	automation_run,
	chat_session,
	norbital_automation_job,
	sync_outbox
} from '@norbital-ai/platform-utils/system/workspace-schema';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { executeTenantBatch } from '$lib/server/bootstrap/tenant_db_binding.js';
import { error } from '$lib/server/http.js';
import { requestI18n } from '$lib/server/i18n.js';
import { PENDING_CONVERSATION_TITLE } from '$lib/server/agent/conversation-title.server.js';
import {
	applyOpenedInteractiveTurn,
	emptyChatSessionAggregate,
	type MutableChatSessionAggregate
} from '$lib/server/agent/chat-session.server.js';
import {
	GUEST_ADMIT_ARTIFACT_MARKER,
	INTERACTIVE_AGENT_AUTOMATION_NAME
} from '$lib/server/run/automation-dispatch.server.js';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import { serializeVerifierScheduled } from '$lib/shared/agent/goal-verdict.js';

export type InteractiveAgentStartPersist = {
	readonly runId: string;
	readonly chatId: string;
	readonly turnId: string;
	readonly promptContent: string;
	readonly inputMessageId: string;
	readonly session: MutableChatSessionAggregate;
	readonly syncSequence: string;
};

type StartSnapshot = Readonly<Record<string, unknown>>;

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function numberOrZero(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sequenceFromRow(row: unknown): string {
	if (!row || typeof row !== 'object') return '0';
	const seq = Reflect.get(row, 'seq');
	if (typeof seq === 'string') return seq;
	if (typeof seq === 'number' || typeof seq === 'bigint') return String(seq);
	return '0';
}

function sessionHasOpenRootTurn(session: Pick<MutableChatSessionAggregate, 'turns'>): boolean {
	return session.turns.some((turn) => turn.subagent_id == null && turn.status === 'running');
}

function openedTranscript(input: {
	readonly message: string;
	readonly model: string;
	readonly planMode?: boolean;
	readonly verify?: boolean;
	readonly verifierPrompt?: string;
	readonly session?: MutableChatSessionAggregate;
}): {
	readonly turnId: string;
	readonly inputMessageId: string;
	readonly session: MutableChatSessionAggregate;
} {
	const session = input.session ?? emptyChatSessionAggregate();
	const opened = applyOpenedInteractiveTurn(session, {
		model: input.model,
		userMessage: input.message,
		userExtra: {
			...(input.planMode ? { plan_mode: true } : {}),
			...(input.verify ? { goal_mode: true } : {})
		},
		...(input.verify
			? {
					systemMessages: [
						{
							content: serializeVerifierScheduled(input.verifierPrompt ?? ''),
							extra: { kind: 'goal' as const }
						}
					]
				}
			: {})
	});
	return {
		turnId: opened.turnId,
		inputMessageId: opened.inputMessageId,
		session
	};
}

function snapshotPayload(input: {
	readonly turnId: string;
	readonly promptContent: string;
	readonly spec: AgentAutomationSpec;
	readonly message: string;
	readonly inputMessageId: string;
	readonly extras: StartSnapshot;
	readonly runId: string;
	readonly chatId: string;
}): StartSnapshot {
	return {
		sessionId: input.chatId,
		runId: input.runId,
		turnId: input.turnId,
		promptContent: input.promptContent,
		spec: input.spec,
		input: input.message,
		inputMessageId: input.inputMessageId,
		...input.extras
	};
}

function chatSessionSnapshot(session: MutableChatSessionAggregate): Record<string, unknown> {
	return {
		norbital_id: session.norbital_id,
		norbital_row_version: session.norbital_row_version,
		title: session.title,
		messages: session.messages,
		turns: session.turns
	};
}

function requireDrizzleDb() {
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) {
		throw new Error('Tenant database is not provisioned');
	}
	return { ctx, db };
}

/**
 * Persist one interactive send and admit the host receipt in one tenant batch.
 */
export async function persistInteractiveAgentStart(input: {
	readonly runId?: string;
	readonly message: string;
	readonly promptContent: string;
	readonly spec: AgentAutomationSpec;
	readonly extras: StartSnapshot;
	readonly planMode?: boolean;
	readonly verify?: boolean;
	readonly verifierPrompt?: string;
}): Promise<InteractiveAgentStartPersist> {
	const { ctx, db } = requireDrizzleDb();
	const ownerUserId = ctx.baseScope.requestor.norbital_id;
	const originScope = ctx.baseScope as unknown as Record<string, unknown>;

	if (!input.runId) {
		const runId = v7();
		const chatId = v7();
		const opened = openedTranscript({
			message: input.message,
			model: input.spec.model ?? 'host-default',
			planMode: input.planMode,
			verify: input.verify,
			verifierPrompt: input.verifierPrompt
		});
		opened.session.norbital_id = chatId;
		opened.session.norbital_row_version = 1;
		opened.session.title = PENDING_CONVERSATION_TITLE;
		const snapshot = snapshotPayload({
			turnId: opened.turnId,
			promptContent: input.promptContent,
			spec: input.spec,
			message: input.message,
			inputMessageId: opened.inputMessageId,
			extras: input.extras,
			runId,
			chatId
		});
		const results = await executeTenantBatch(ctx.tenantDb, [
			db.insert(automation_run).values({
				norbital_id: runId,
				requested_by_user_id: ownerUserId,
				automation_name: null,
				status: 'pending',
				input: { task: 'Interactive workspace conversation' }
			}),
			db.insert(chat_session).values({
				norbital_id: chatId,
				user_id: ownerUserId,
				automation_run_id: runId,
				title: PENDING_CONVERSATION_TITLE,
				visibility: 'personal',
				messages: opened.session.messages,
				turns: opened.session.turns
			}),
			db
				.insert(norbital_automation_job)
				.values({
					automation_name: INTERACTIVE_AGENT_AUTOMATION_NAME,
					trigger_key: `turn:${chatId}:${opened.turnId}`,
					artifact_id: GUEST_ADMIT_ARTIFACT_MARKER,
					checkpoint_id: GUEST_ADMIT_ARTIFACT_MARKER,
					tree_hash: GUEST_ADMIT_ARTIFACT_MARKER,
					runtime_version: GUEST_ADMIT_ARTIFACT_MARKER,
					origin_scope: originScope,
					record_snapshot: snapshot,
					source_pointer: `turn:${chatId}:${opened.turnId}`
				})
				.onConflictDoNothing(),
			db
				.insert(sync_outbox)
				.values({
					collection: 'chat_session',
					record_id: chatId,
					action: 'create',
					row_version: 1,
					origin_scope: originScope,
					record_snapshot: chatSessionSnapshot(opened.session)
				})
				.returning({ seq: sync_outbox.seq })
		]);
		const outbox = results.at(-1)?.rows[0];
		return {
			runId,
			chatId,
			turnId: opened.turnId,
			promptContent: input.promptContent,
			inputMessageId: opened.inputMessageId,
			session: opened.session,
			syncSequence: sequenceFromRow(outbox)
		};
	}

	const existing = await db
		.select({
			runId: automation_run.norbital_id,
			requestedByUserId: automation_run.requested_by_user_id,
			automationName: automation_run.automation_name,
			runStatus: automation_run.status,
			chatId: chat_session.norbital_id,
			title: chat_session.title,
			messages: chat_session.messages,
			turns: chat_session.turns,
			rowVersion: chat_session.norbital_row_version,
			usageCostUsd: chat_session.usage_cost_usd,
			usageTotalTokens: chat_session.usage_total_tokens,
			usageTurnsCounted: chat_session.usage_turns_counted,
			usageTurnsUnreported: chat_session.usage_turns_unreported
		})
		.from(automation_run)
		.leftJoin(chat_session, eq(chat_session.automation_run_id, automation_run.norbital_id))
		.where(eq(automation_run.norbital_id, input.runId))
		.limit(1);
	const row = existing[0];
	if (!row) {
		throw error(404, requestI18n().t('pod.server.agentConversationNotFound'));
	}
	if (row.automationName != null) {
		throw error(404, requestI18n().t('pod.server.agentConversationNotFound'));
	}
	if (row.requestedByUserId !== ownerUserId) {
		throw error(403, requestI18n().t('pod.server.agentConversationPrivate'));
	}
	if (row.runStatus === 'running') {
		throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
	}

	if (row.chatId) {
		const session: MutableChatSessionAggregate = {
			norbital_id: row.chatId,
			norbital_row_version: numberOrZero(row.rowVersion),
			title: typeof row.title === 'string' ? row.title : PENDING_CONVERSATION_TITLE,
			messages: asArray(row.messages),
			turns: asArray(row.turns),
			usage_cost_usd: numberOrZero(row.usageCostUsd),
			usage_total_tokens: numberOrZero(row.usageTotalTokens),
			usage_turns_counted: numberOrZero(row.usageTurnsCounted),
			usage_turns_unreported: numberOrZero(row.usageTurnsUnreported)
		};
		if (sessionHasOpenRootTurn(session)) {
			throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
		}
		const expectedVersion = session.norbital_row_version;
		const opened = openedTranscript({
			message: input.message,
			model: input.spec.model ?? 'host-default',
			planMode: input.planMode,
			verify: input.verify,
			verifierPrompt: input.verifierPrompt,
			session
		});
		opened.session.norbital_row_version = expectedVersion + 1;
		const snapshot = snapshotPayload({
			turnId: opened.turnId,
			promptContent: input.promptContent,
			spec: input.spec,
			message: input.message,
			inputMessageId: opened.inputMessageId,
			extras: input.extras,
			runId: input.runId,
			chatId: row.chatId
		});
		const results = await executeTenantBatch(ctx.tenantDb, [
			db
				.update(chat_session)
				.set({
					messages: opened.session.messages,
					turns: opened.session.turns,
					norbital_updated_at: new Date()
				})
				.where(
					and(
						eq(chat_session.norbital_id, row.chatId),
						eq(chat_session.norbital_row_version, expectedVersion),
						eq(chat_session.user_id, ownerUserId)
					)
				),
			db
				.insert(norbital_automation_job)
				.values({
					automation_name: INTERACTIVE_AGENT_AUTOMATION_NAME,
					trigger_key: `turn:${row.chatId}:${opened.turnId}`,
					artifact_id: GUEST_ADMIT_ARTIFACT_MARKER,
					checkpoint_id: GUEST_ADMIT_ARTIFACT_MARKER,
					tree_hash: GUEST_ADMIT_ARTIFACT_MARKER,
					runtime_version: GUEST_ADMIT_ARTIFACT_MARKER,
					origin_scope: originScope,
					record_snapshot: snapshot,
					source_pointer: `turn:${row.chatId}:${opened.turnId}`
				})
				.onConflictDoNothing(),
			db
				.insert(sync_outbox)
				.values({
					collection: 'chat_session',
					record_id: row.chatId,
					action: 'update',
					row_version: opened.session.norbital_row_version,
					origin_scope: originScope,
					record_snapshot: chatSessionSnapshot(opened.session)
				})
				.returning({ seq: sync_outbox.seq })
		]);
		if ((results[0]?.rowCount ?? 0) < 1) {
			throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
		}
		return {
			runId: input.runId,
			chatId: row.chatId,
			turnId: opened.turnId,
			promptContent: input.promptContent,
			inputMessageId: opened.inputMessageId,
			session: opened.session,
			syncSequence: sequenceFromRow(results.at(-1)?.rows[0])
		};
	}

	const chatId = v7();
	const opened = openedTranscript({
		message: input.message,
		model: input.spec.model ?? 'host-default',
		planMode: input.planMode,
		verify: input.verify,
		verifierPrompt: input.verifierPrompt
	});
	opened.session.norbital_id = chatId;
	opened.session.norbital_row_version = 1;
	opened.session.title = PENDING_CONVERSATION_TITLE;
	const snapshot = snapshotPayload({
		turnId: opened.turnId,
		promptContent: input.promptContent,
		spec: input.spec,
		message: input.message,
		inputMessageId: opened.inputMessageId,
		extras: input.extras,
		runId: input.runId,
		chatId
	});
	const results = await executeTenantBatch(ctx.tenantDb, [
		db.insert(chat_session).values({
			norbital_id: chatId,
			user_id: ownerUserId,
			automation_run_id: input.runId,
			title: PENDING_CONVERSATION_TITLE,
			visibility: 'personal',
			messages: opened.session.messages,
			turns: opened.session.turns
		}),
		db
			.insert(norbital_automation_job)
			.values({
				automation_name: INTERACTIVE_AGENT_AUTOMATION_NAME,
				trigger_key: `turn:${chatId}:${opened.turnId}`,
				artifact_id: GUEST_ADMIT_ARTIFACT_MARKER,
				checkpoint_id: GUEST_ADMIT_ARTIFACT_MARKER,
				tree_hash: GUEST_ADMIT_ARTIFACT_MARKER,
				runtime_version: GUEST_ADMIT_ARTIFACT_MARKER,
				origin_scope: originScope,
				record_snapshot: snapshot,
				source_pointer: `turn:${chatId}:${opened.turnId}`
			})
			.onConflictDoNothing(),
		db
			.insert(sync_outbox)
			.values({
				collection: 'chat_session',
				record_id: chatId,
				action: 'create',
				row_version: 1,
				origin_scope: originScope,
				record_snapshot: chatSessionSnapshot(opened.session)
			})
			.returning({ seq: sync_outbox.seq })
	]);
	return {
		runId: input.runId,
		chatId,
		turnId: opened.turnId,
		promptContent: input.promptContent,
		inputMessageId: opened.inputMessageId,
		session: opened.session,
		syncSequence: sequenceFromRow(results.at(-1)?.rows[0])
	};
}
