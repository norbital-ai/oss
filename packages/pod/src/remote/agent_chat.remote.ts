import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { parseCompactDirective } from '$lib/server/agent/agent-loop.server.js';
import { composeMentionContext } from '$lib/server/agent/agent-mentions.server.js';
import { persistInteractiveAgentStart } from '$lib/server/agent/agent-start.server.js';
import { interactiveAgentStartSpec } from '$lib/server/agent/agent-spec.server.js';
import { getRuntimeFacilities } from '$lib/server/facilities.js';
import type { AiModelCatalog } from '@norbital-ai/platform-utils/runtime/binding';
import { error } from '$lib/server/http.js';
import { requestI18n } from '$lib/server/i18n.js';
import { updateScheduledVerifierPrompt } from '$lib/server/agent/goal-mode.server.js';
import { resolveAgentIntent } from '$lib/shared/agent/intent.js';
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
	 * persist already refuses a run belonging to another requestor, so continuation inherits that
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
	mentions: z.array(AgentMentionSchema).max(20).optional(),
	/** Host-injected admit artifact. Clients must not send this; the host overwrites it. */
	artifact: z
		.object({
			artifactId: z.string().min(1).max(512),
			checkpointId: z.string().min(1).max(512),
			treeHash: z.string().min(1).max(512),
			runtimeVersion: z.string().min(1).max(512)
		})
		.optional()
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

const authenticated = Guard.init().use(requireAuthMiddleware());

/**
 * Start a live interactive turn and return its transcript identity before provider inference begins.
 *
 * An interactive conversation is a run with no automation name. One drizzle batch persists the run,
 * session, user message, turn, and `_norbital_automation_job` receipt. The host drives one provider
 * transition per guest `automation-events` run. Title, message parts, tool state, and turn
 * completion replicate through the tenant-owned `chat_session` aggregate.
 */
export const agentChatStart = authenticated.command(
	AgentChatInputSchema,
	async (input): Promise<AgentChatStartResult> => {
		// Before the conversation exists: a rejected model must fail the request outright rather than
		// leave a started run whose first visible event is an error.
		const model = await resolveModel(input.model);
		const ctx = getWorkspace({ provision: true });
		const compact = parseCompactDirective(input.message);
		const spec = interactiveAgentStartSpec(input.message, model);
		const mentionContext = input.mentions?.length
			? await composeMentionContext(ctx, input.mentions)
			: null;
		const promptContent = mentionContext ? `${input.message}\n\n${mentionContext}` : input.message;
		const intent = chatIntentFields(input);
		const persisted = await persistInteractiveAgentStart({
			runId: input.runId,
			message: input.message,
			promptContent,
			spec,
			extras: {
				...intent,
				...(input.mentions?.length ? { mentions: input.mentions } : {}),
				...(compact ? { compact } : {})
			},
			planMode: intent.planMode,
			verify: intent.goalMode,
			verifierPrompt: intent.verifierPrompt,
			...(input.artifact ? { artifact: input.artifact } : {})
		});
		return {
			runId: persisted.runId,
			chatId: persisted.chatId,
			accepted: true,
			session: persisted.session,
			syncSequence: persisted.syncSequence
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
