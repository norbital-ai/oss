/**
 * Interactive agent start: resolve one collection row, open its transcript, then commit the
 * domain write, durable admission receipt, and sync receipt in one host batch.
 */
import { v7 } from 'uuid';
import { and, eq } from 'drizzle-orm';
import {
	automation_run,
	chat_session,
	ChatSessionMessagesSchema,
	ChatSessionTurnsSchema,
	norbital_automation_job,
	sync_outbox
} from '@norbital-ai/platform-utils/system/workspace-schema';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { executeTenantBatch, type CompilableSql } from '$lib/server/bootstrap/tenant_db_binding.js';
import { error } from '$lib/server/http.js';
import { requestI18n } from '$lib/server/i18n.js';
import { PENDING_CONVERSATION_TITLE } from '$lib/server/agent/conversation-title.server.js';
import {
	applyOpenedInteractiveTurn,
	type MutableChatSessionAggregate
} from '$lib/server/agent/chat-session.server.js';
import { INTERACTIVE_AGENT_AUTOMATION_NAME } from '$lib/server/run/automation-dispatch.server.js';
import { requireAdmitArtifact, type AdmitArtifact } from '$lib/server/run/admit-artifact.js';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import { serializeVerifierScheduled } from '$lib/shared/agent/goal-verdict.js';

/** Persist one interactive send and admit the host receipt in one tenant batch. */
export async function persistInteractiveAgentStart(input: {
	readonly runId?: string;
	readonly message: string;
	readonly promptContent: string;
	readonly spec: AgentAutomationSpec;
	readonly extras: Readonly<Record<string, unknown>>;
	readonly planMode?: boolean;
	readonly verify?: boolean;
	readonly verifierPrompt?: string;
	readonly artifact?: AdmitArtifact;
}) {
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');

	const ownerUserId = ctx.baseScope.requestor.norbital_id;
	const originScope = { ...ctx.baseScope };
	const artifact = requireAdmitArtifact(input.artifact);
	const runId = input.runId ?? v7();
	const statements: CompilableSql[] = [];
	let chatId = v7();
	let action: 'create' | 'update' = 'create';
	let expectedVersion: number | null = null;
	let session: MutableChatSessionAggregate = {
		norbital_id: chatId,
		norbital_row_version: 1,
		user_id: ownerUserId,
		automation_run_id: runId,
		title: PENDING_CONVERSATION_TITLE,
		visibility: 'personal',
		platform: null,
		channel_key: null,
		external_thread_id: null,
		messages: [],
		turns: [],
		usage_cost_usd: 0,
		usage_total_tokens: 0,
		usage_turns_counted: 0,
		usage_turns_unreported: 0
	};

	if (input.runId) {
		const existing = await db
			.select({ automation_run, chat_session })
			.from(automation_run)
			.leftJoin(chat_session, eq(chat_session.automation_run_id, automation_run.norbital_id))
			.where(eq(automation_run.norbital_id, input.runId))
			.limit(1);
		const row = existing[0];
		if (!row || row.automation_run.automation_name != null) {
			throw error(404, requestI18n().t('pod.server.agentConversationNotFound'));
		}
		if (row.automation_run.requested_by_user_id !== ownerUserId) {
			throw error(403, requestI18n().t('pod.server.agentConversationPrivate'));
		}
		if (row.automation_run.status === 'running') {
			throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
		}

		if (row.chat_session) {
			chatId = row.chat_session.norbital_id;
			expectedVersion = row.chat_session.norbital_row_version ?? 0;
			action = 'update';
			session = {
				...row.chat_session,
				norbital_row_version: expectedVersion,
				messages: ChatSessionMessagesSchema.parse(row.chat_session.messages),
				turns: ChatSessionTurnsSchema.parse(row.chat_session.turns)
			};
			if (session.turns.some((turn) => turn.subagent_id == null && turn.status === 'running')) {
				throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
			}
		}
	} else {
		statements.push(
			db.insert(automation_run).values({
				norbital_id: runId,
				requested_by_user_id: ownerUserId,
				automation_name: null,
				status: 'pending',
				input: { task: 'Interactive workspace conversation' }
			})
		);
	}

	const opened = applyOpenedInteractiveTurn(session, {
		model: input.spec.model ?? 'host-default',
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
	if (action === 'update') session.norbital_row_version = (expectedVersion ?? 0) + 1;

	const chatWriteIndex = statements.length;
	if (action === 'create') {
		statements.push(db.insert(chat_session).values(session));
	} else {
		statements.push(
			db
				.update(chat_session)
				.set({
					messages: session.messages,
					turns: session.turns,
					norbital_row_version: session.norbital_row_version,
					norbital_updated_at: new Date()
				})
				.where(
					and(
						eq(chat_session.norbital_id, chatId),
						eq(chat_session.norbital_row_version, expectedVersion ?? 0),
						eq(chat_session.user_id, ownerUserId)
					)
				)
		);
	}

	const snapshot = {
		sessionId: chatId,
		runId,
		turnId: opened.turnId,
		promptContent: input.promptContent,
		spec: input.spec,
		input: input.message,
		inputMessageId: opened.inputMessageId,
		...input.extras
	};
	statements.push(
		db
			.insert(norbital_automation_job)
			.values({
				automation_name: INTERACTIVE_AGENT_AUTOMATION_NAME,
				trigger_key: `turn:${chatId}:${opened.turnId}`,
				artifact_id: artifact.artifactId,
				checkpoint_id: artifact.checkpointId,
				tree_hash: artifact.treeHash,
				runtime_version: artifact.runtimeVersion,
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
				action,
				row_version: session.norbital_row_version,
				origin_scope: originScope,
				// The sync diff re-reads the policy-scoped canonical row. Copying an increasingly large
				// transcript into the outbox is a second data structure nobody consumes.
				record_snapshot: { norbital_id: chatId }
			})
			.returning({ seq: sync_outbox.seq })
	);

	const results = await executeTenantBatch(ctx.tenantDb, statements);
	if (action === 'update' && (results[chatWriteIndex]?.rowCount ?? 0) < 1) {
		throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
	}
	const sequence = results.at(-1)?.rows[0]?.seq;
	return {
		runId,
		chatId,
		turnId: opened.turnId,
		promptContent: input.promptContent,
		inputMessageId: opened.inputMessageId,
		session,
		syncSequence:
			typeof sequence === 'string' || typeof sequence === 'number' || typeof sequence === 'bigint'
				? String(sequence)
				: '0'
	};
}

export type InteractiveAgentStartPersist = Awaited<ReturnType<typeof persistInteractiveAgentStart>>;
