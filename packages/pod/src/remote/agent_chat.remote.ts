import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { createRecord } from '$lib/server/collection/collection_ops.server.js';
import { withCollectionTransaction } from '$lib/server/collection/collection_transaction.server.js';
import { latestOutboxSeqInTransaction } from '$lib/server/collection/sync/outbox-tailer.server.js';
import {
	parseCompactDirective,
	prepareInteractiveAgentTurn
} from '$lib/server/agent/agent-loop.server.js';
import { interactiveAgentStartSpec } from '$lib/server/agent/agent-spec.server.js';
import { getRuntimeFacilities } from '$lib/server/facilities.js';
import type { AiModelCatalog } from '@norbital-ai/platform-utils/runtime/binding';
import { error } from '$lib/server/http.js';
import { requestI18n } from '$lib/server/i18n.js';
import { PENDING_CONVERSATION_TITLE } from '$lib/server/agent/conversation-title.server.js';
import {
	failOpenInteractiveTurn
} from '$lib/server/agent/chat-session.server.js';
import {
	admitAgentTurn,
	INTERACTIVE_AGENT_AUTOMATION_NAME
} from '$lib/server/run/automation-dispatch.server.js';
import { updateScheduledVerifierPrompt } from '$lib/server/agent/goal-mode.server.js';
import { resolveAgentIntent } from '$lib/shared/agent/intent.js';
import { rethrowConstraintViolation } from '$lib/server/collection/constraint-errors.server.js';
import { z } from 'zod';

/** Resolve composer intent fields onto the snapshot the durable turn will replay. */
function chatIntentFields(input: {
	readonly message?: string;
	readonly planMode?: boolean;
	readonly intent?: 'do' | 'plan';
	readonly verifierPrompt?: string;
	readonly mentions?: readonly unknown[];
}): {
	readonly planMode?: true;
	readonly intent: 'do' | 'plan';
	readonly verifierPrompt?: string;
	readonly goalMode?: true;
} {
	const resolved = resolveAgentIntent({
		intent: input.intent,
		planMode: input.planMode,
		verifierPrompt: input.verifierPrompt,
		message: input.message,
		mentionCount: input.mentions?.length
	});
	return {
		...(resolved.planMode ? { planMode: true as const } : {}),
		intent: resolved.intent,
		...(resolved.verify ? { verifierPrompt: resolved.verifierPrompt, goalMode: true as const } : {})
	};
}

/**
 * The shape of a model identifier, which is all this package can judge on its own.
 *
 * Whether a well-formed id is one this host will actually run is a question only the host can
 * answer, and `resolveModel` below asks it rather than guessing from a list kept here.
 */
const ModelIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9~][a-zA-Z0-9._~:/-]*$/, 'Invalid model identifier.');

/**
 * One record the composer's "@" picker resolved.
 *
 * Shape-checked here, trust-checked server-side: the loop fetches each reference as the requestor,
 * so a well-formed id the person cannot read injects nothing.
 */
const AgentMentionSchema = z.object({
	collection: z.string().min(1).max(200),
	recordId: z.uuid(),
	label: z.string().min(1).max(500)
});

export const AgentChatInputSchema = z.object({
	message: z.string().min(1),
	/**
	 * Continue an existing conversation. Omitted starts a new one.
	 *
	 * The run id rather than the chat id, because that is what the loop resumes from — and because
	 * `prepareConversation` already refuses a run belonging to another requestor, so continuation
	 * inherits that check instead of repeating it here.
	 */
	runId: z.uuid().optional(),
	/** Run this turn on a specific model. Omitted leaves the choice to the host. */
	model: ModelIdSchema.optional(),
	/**
	 * Research-only turn. When true the loop withholds write tools and records `plan_mode` on the
	 * user message. Omitted / false is a normal turn.
	 */
	planMode: z.boolean().optional(),
	/** `do` (default) or `plan`. `planMode: true` is the same as `intent: 'plan'`. */
	intent: z.enum(['do', 'plan']).optional(),
	/**
	 * Prompt the independent end-action verifier reads. Omitted uses the intent default.
	 * The composer shows this same text.
	 */
	verifierPrompt: z.string().max(4000).optional(),
	/**
	 * @deprecated Every root turn verifies. Kept so older callers still parse.
	 */
	goalMode: z.boolean().optional(),
	/**
	 * Records the caller referenced with "@" in the composer. An `@` that never matched a record is
	 * simply text in the message and never appears here.
	 */
	mentions: z.array(AgentMentionSchema).max(20).optional()
});

export const AgentModelsInputSchema = z.object({});

export const AgentChatUpdateVerifierInputSchema = z.object({
	runId: z.uuid(),
	prompt: z.string().min(1).max(4000)
});

export type AgentChatStartResult = {
	readonly runId: string;
	readonly chatId: string;
	readonly accepted: true;
	readonly session: Record<string, unknown>;
	readonly syncSequence: string;
};

/**
 * What the host will run, or nothing.
 *
 * Optional on the binding rather than required: a host may hold one set of credentials and offer no
 * choice at all, and returning an empty catalog would misreport that as "no models".
 */
async function hostModelCatalog(): Promise<AiModelCatalog | null> {
	const ai = getRuntimeFacilities().ai;
	return ai?.models ? await ai.models() : null;
}

/**
 * Accept a caller's model only if the host offers it.
 *
 * The shape check on the wire keeps out malformed input; this keeps out a well-formed id the host
 * never advertised. Model choice is spend, so the ceiling has to come from the side holding the
 * credentials rather than from whatever the client had rendered when it sent.
 */
async function resolveModel(model: string | undefined): Promise<string | undefined> {
	if (model === undefined) return undefined;
	const catalog = await hostModelCatalog();
	if (!catalog) throw error(400, requestI18n().t('pod.server.noModelChoice'));
	if (!catalog.options.some((option) => option.id === model)) {
		throw error(400, requestI18n().t('pod.server.modelUnavailable', { model }));
	}
	return model;
}

type PreparedConversation = {
	readonly runId: string;
	readonly chatId: string;
	readonly session: Record<string, unknown>;
};

/** True when the session already has a root turn the host has not finished. */
function sessionHasOpenRootTurn(session: Record<string, unknown>): boolean {
	const turns = session.turns;
	if (!Array.isArray(turns)) return false;
	return turns.some((turn) => {
		if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return false;
		const row = turn as Record<string, unknown>;
		return row.subagent_id == null && (row.status === 'running' || row.status === 'queued');
	});
}

/** Admit the opened turn as a guest receipt the host will drive. */
async function admitInteractiveTurn(
	conversation: PreparedConversation,
	snapshot: Record<string, unknown>
): Promise<void> {
	try {
		await admitAgentTurn(getWorkspace({ provision: true }), {
			automationName: INTERACTIVE_AGENT_AUTOMATION_NAME,
			triggerKey: `turn:${conversation.chatId}:${String(snapshot.turnId)}`,
			originScope: getWorkspace({ provision: true }).baseScope,
			snapshot
		});
	} catch (cause) {
		rethrowConstraintViolation(cause, '_norbital_automation_job');
		const code =
			cause && typeof cause === 'object' ? Reflect.get(cause, 'code') : undefined;
		if (code === '42P01' || code === '42501') {
			throw error(500, requestI18n().t('pod.server.agentStartFailed'));
		}
		throw cause;
	}
}

/** Create or resume the requestor's interactive run and chat session. */
async function prepareConversation(runId?: string): Promise<PreparedConversation> {
	const ctx = getWorkspace({ provision: true });
	const ownerUserId = ctx.baseScope.requestor.norbital_id;
	const createSession = async (automationRunId: string): Promise<PreparedConversation> => {
		const session = await createRecord(
			ctx,
			'chat_session',
			{
				user_id: ownerUserId,
				automation_run_id: automationRunId,
				title: PENDING_CONVERSATION_TITLE,
				visibility: 'personal'
			},
			{ isElevated: true }
		);
		if (typeof session.norbital_id !== 'string') throw new Error('Agent session has no id');
		return { runId: automationRunId, chatId: session.norbital_id, session };
	};
	if (runId) {
		const existing = await ctx.tenantDb.query<{
			requested_by_user_id: string;
			automation_name: string | null;
			status: string;
			chat_id: string | null;
		}>({
			text: `SELECT r.requested_by_user_id, r.automation_name, r.status,
			              s.norbital_id AS chat_id
			         FROM automation_run r
			    LEFT JOIN chat_session s ON s.automation_run_id = r.norbital_id
			        WHERE r.norbital_id = $1::uuid
			        LIMIT 1`,
			values: [runId]
		});
		const row = existing.rows[0];
		if (!row || row.automation_name !== null)
			throw error(404, requestI18n().t('pod.server.agentConversationNotFound'));
		if (row.requested_by_user_id !== ownerUserId)
			throw error(403, requestI18n().t('pod.server.agentConversationPrivate'));
		if (row.chat_id) {
			const selected = await ctx.tenantDb.query<Record<string, unknown>>(
				`SELECT * FROM chat_session
				  WHERE norbital_id = $1::uuid
				    AND user_id = $2::uuid
				  LIMIT 1`,
				[row.chat_id, ownerUserId]
			);
			const session = selected.rows[0];
			if (!session) throw error(404, requestI18n().t('pod.server.agentConversationNotFound'));
			if (row.status === 'running' || sessionHasOpenRootTurn(session))
				throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
			return { runId, chatId: row.chat_id, session };
		}
		if (row.status === 'running')
			throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
		return createSession(runId);
	}

	const run = await createRecord(
		ctx,
		'automation_run',
		{
			requested_by_user_id: ownerUserId,
			automation_name: null,
			status: 'pending',
			input: { task: 'Interactive workspace conversation' }
		},
		{ isElevated: true }
	);
	if (typeof run.norbital_id !== 'string') throw new Error('Agent run has no id');
	return createSession(run.norbital_id);
}

const authenticated = Guard.init().use(requireAuthMiddleware());

/**
 * Start a live interactive turn and return its transcript identity before provider inference begins.
 *
 * An interactive conversation is a run with no automation name. The billed invoke persists the run,
 * session, user message and turn, then admits an `_norbital_automation_job` receipt. The host
 * drives one provider transition per guest `automation-events` run. Title, message parts, tool
 * state, and turn completion replicate through the tenant-owned `chat_session` aggregate.
 */
export const agentChatStart = authenticated.command(
	AgentChatInputSchema,
	async (input): Promise<AgentChatStartResult> => {
		// Before the conversation exists: a rejected model must fail the request outright rather than
		// leave a started run whose first visible event is an error.
		const model = await resolveModel(input.model);
		const ctx = getWorkspace({ provision: true });
		let admitError: unknown;
		const started = await withCollectionTransaction(ctx, async () => {
			const conversation = await prepareConversation(input.runId);
			const compact = parseCompactDirective(input.message);
			const spec = interactiveAgentStartSpec(input.message, model);
			await ctx.tenantDb.query('SAVEPOINT agent_start_after_create');
			let openedTurnId: string | undefined;
			try {
				const opened = await prepareInteractiveAgentTurn({
					sessionId: conversation.chatId,
					spec,
					message: input.message,
					...chatIntentFields(input),
					...(input.mentions?.length ? { mentions: input.mentions } : {})
				});
				openedTurnId = opened.turnId;
				const snapshot = {
					sessionId: conversation.chatId,
					runId: conversation.runId,
					turnId: opened.turnId,
					promptContent: opened.promptContent,
					spec,
					input: input.message,
					...(opened.inputMessageId ? { inputMessageId: opened.inputMessageId } : {}),
					...chatIntentFields(input),
					...(input.mentions?.length ? { mentions: input.mentions } : {}),
					...(compact ? { compact } : {})
				};
				await ctx.tenantDb.query('SAVEPOINT agent_start_before_admit');
				try {
					await admitInteractiveTurn(conversation, snapshot);
				} catch (cause) {
					await ctx.tenantDb.query('ROLLBACK TO SAVEPOINT agent_start_before_admit');
					const message = cause instanceof Error ? cause.message : String(cause);
					await failOpenInteractiveTurn(conversation.chatId, opened.turnId, message);
					admitError = cause;
				}
				return {
					conversation,
					session: opened.session,
					syncSequence: await latestOutboxSeqInTransaction(ctx)
				};
			} catch (cause) {
				if (openedTurnId === undefined) {
					await ctx.tenantDb.query('ROLLBACK TO SAVEPOINT agent_start_after_create');
				}
				throw cause;
			}
		});
		if (admitError) throw admitError;
		return {
			...started.conversation,
			session: started.session,
			accepted: true,
			syncSequence: started.syncSequence
		};
	}
);

/**
 * The models this workspace can be talked to on, and the one it uses by default.
 *
 * Read straight from the host on every call rather than cached here. The catalog is the host's, and
 * a copy in this package would be a second answer to "what is about to run" — exactly the mismatch a
 * picker exists to prevent.
 */
export const agentModels = authenticated.query(
	AgentModelsInputSchema,
	async (): Promise<AiModelCatalog | null> => hostModelCatalog()
);

/**
 * Replace the scheduled verifier prompt on an open conversation the requestor owns.
 */
export const agentChatUpdateVerifier = authenticated.command(
	AgentChatUpdateVerifierInputSchema,
	async (input): Promise<{ readonly accepted: true }> => {
		const ctx = getWorkspace({ provision: true });
		const ownerUserId = ctx.baseScope.requestor.norbital_id;
		const existing = await ctx.tenantDb.query<{
			requested_by_user_id: string;
			automation_name: string | null;
			chat_id: string | null;
		}>({
			text: `SELECT r.requested_by_user_id, r.automation_name, s.norbital_id AS chat_id
			         FROM automation_run r
			    LEFT JOIN chat_session s ON s.automation_run_id = r.norbital_id
			        WHERE r.norbital_id = $1::uuid
			        LIMIT 1`,
			values: [input.runId]
		});
		const row = existing.rows[0];
		if (!row || row.automation_name !== null || !row.chat_id)
			throw error(404, requestI18n().t('pod.server.agentConversationNotFound'));
		if (row.requested_by_user_id !== ownerUserId)
			throw error(403, requestI18n().t('pod.server.agentConversationPrivate'));
		await updateScheduledVerifierPrompt(row.chat_id, input.prompt);
		return { accepted: true };
	}
);
