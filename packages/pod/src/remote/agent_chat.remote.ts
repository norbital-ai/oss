import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { createRecord } from '$lib/server/collection/collection_ops.server.js';
import { parseCompactDirective, runAgent } from '$lib/server/agent/agent-loop.server.js';
import { interactiveAgentSpec } from '$lib/server/agent/agent-spec.server.js';
import { requireRuntimeFacility } from '$lib/server/facilities.js';
import type { AiModelCatalog } from '@norbital-ai/platform-utils/runtime/binding';
import { error } from '$lib/server/http.js';
import { requestI18n } from '$lib/server/i18n.js';
import { PENDING_CONVERSATION_TITLE } from '$lib/server/agent/conversation-title.server.js';
import { z } from 'zod';

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
	 * `runAgent` already refuses a run belonging to another requestor, so continuation inherits that
	 * check instead of repeating it here.
	 */
	runId: z.uuid().optional(),
	/** Run this turn on a specific model. Omitted leaves the choice to the host. */
	model: ModelIdSchema.optional(),
	/**
	 * Research-only turn. When true the loop withholds write tools and records `plan_mode` on the
	 * user message. Omitted / false is a normal turn.
	 */
	planMode: z.boolean().optional(),
	/**
	 * Records the caller referenced with "@" in the composer. An `@` that never matched a record is
	 * simply text in the message and never appears here.
	 */
	mentions: z.array(AgentMentionSchema).max(20).optional()
});

export const AgentModelsInputSchema = z.object({});

export type AgentChatResult = {
	readonly runId: string;
	readonly chatId: string | null;
	readonly text: string;
};

export type AgentChatStartResult = {
	readonly runId: string;
	readonly chatId: string;
	readonly accepted: true;
};

/**
 * What the host will run, or nothing.
 *
 * Optional on the binding rather than required: a host may hold one set of credentials and offer no
 * choice at all, and returning an empty catalog would misreport that as "no models".
 */
async function hostModelCatalog(): Promise<AiModelCatalog | null> {
	const ai = requireRuntimeFacility('ai');
	return ai.models ? await ai.models() : null;
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

async function prepareConversation(runId?: string): Promise<{ runId: string; chatId: string }> {
	const ctx = getWorkspace({ provision: true });
	const ownerUserId = ctx.baseScope.requestor.norbital_id;
	const createSession = async (
		automationRunId: string
	): Promise<{ runId: string; chatId: string }> => {
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
		return { runId: automationRunId, chatId: session.norbital_id };
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
		if (row.status === 'running')
			throw error(409, requestI18n().t('pod.server.agentAlreadyResponding'));
		if (row.chat_id) return { runId, chatId: row.chat_id };
		return createSession(runId);
	}

	const run = await createRecord(
		ctx,
		'automation_run',
		{
			requested_by_user_id: ownerUserId,
			automation_name: null,
			status: 'running',
			input: { task: 'Interactive workspace conversation' },
			started_at: new Date().toISOString()
		},
		{ isElevated: true }
	);
	if (typeof run.norbital_id !== 'string') throw new Error('Agent run has no id');
	return createSession(run.norbital_id);
}

const authenticated = Guard.init().use(requireAuthMiddleware());

/**
 * Talk to the workspace agent.
 *
 * The interactive counterpart to an agent automation, and the same machinery: an interactive
 * conversation is a run with no automation name. It writes the same `chat_session`/`chat_message`
 * transcript, so a conversation replicates to its owner through ordinary sync rather than needing a
 * streaming channel of its own.
 *
 * What the conversation may reach when the workspace authored no profile is decided by
 * `interactiveAgentSpec`, including the part that is not conservative — read its doc comment before
 * changing anything here.
 *
 * `src/+agent.ts` narrows that. It is also the answer for the case policy cannot cover: a channel
 * with no authenticated requestor to scope against, such as a public WhatsApp or Telegram surface,
 * where the profile has to supply the boundary by hand.
 */
export const agentChat = authenticated.command(
	AgentChatInputSchema,
	async (input): Promise<AgentChatResult> => {
		const spec = await interactiveAgentSpec('Assist with questions about this workspace.');
		const result = await runAgent({
			automationName: null,
			spec,
			input: input.message,
			...(input.runId ? { runId: input.runId } : {}),
			...(input.planMode ? { planMode: true } : {}),
			...(input.mentions?.length ? { mentions: input.mentions } : {})
		});

		const ctx = getWorkspace({ provision: true });
		const session = await ctx.tenantDb.query<{ norbital_id: string }>({
			text: `SELECT norbital_id FROM chat_session WHERE automation_run_id = $1::uuid LIMIT 1`,
			values: [result.runId]
		});
		return {
			runId: result.runId,
			chatId: session.rows[0]?.norbital_id ?? null,
			text: result.text
		};
	}
);

/**
 * Start a live interactive turn and return its transcript identity before provider inference begins.
 *
 * The long-running loop remains inside Pod and writes the tenant transcript. Returning after the
 * run/session exist lets a client subscribe to ordinary sync before the first assistant delta lands.
 */
export const agentChatStart = authenticated.command(
	AgentChatInputSchema,
	async (input): Promise<AgentChatStartResult> => {
		// Before the conversation exists: a rejected model must fail the request outright rather than
		// leave a started run whose first visible event is an error.
		const model = await resolveModel(input.model);
		const conversation = await prepareConversation(input.runId);
		// A directive still becomes a stored user message and a turn — the reader typed it, and the
		// transcript should show what they asked for beside what it did.
		const compact = parseCompactDirective(input.message);
		// Resolved before the run is launched, not inside it: `allHostTools` reads a request-scoped
		// facility, and the detached promise below outlives the request that would supply it.
		const spec = await interactiveAgentSpec(input.message, model);
		void runAgent({
			automationName: null,
			runId: conversation.runId,
			sessionId: conversation.chatId,
			spec,
			input: input.message,
			...(input.planMode ? { planMode: true } : {}),
			...(input.mentions?.length ? { mentions: input.mentions } : {}),
			...(compact ? { compact } : {})
		}).catch(() => undefined);
		return { ...conversation, accepted: true };
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
